import type { ContextCompiler } from "@/lib/context/context-compiler";
import { buildMemoryContext } from "@/lib/context/memory";
import type { ConversationStore } from "@/lib/conversations/store";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { errorMessage } from "@/lib/errors";
import {
  findHumanIdentity,
  loadHumanIdentities,
} from "@/lib/identity/resolver";
import type { HumanIdentityConfig } from "@/lib/identity/types";
import { createLogger } from "@/lib/logging";
import type {
  DesktopHands,
  DesktopHandsLease,
} from "@/lib/provider/desktop-hands";
import { leaseDesktopHands } from "@/lib/provider/desktop-hands";
import type { PiAccountRoutingRequest } from "@/lib/provider/pi-account-routing";
import {
  type ModelProviderClient,
  ProviderTurnError,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import { ThreadQueue } from "@/lib/turns/turn-queue";
import type { GitHubAppConfig } from "@/surfaces/github/config";
import type {
  GitHubNotification,
  GitHubUser,
  IssueComment,
  ReviewComment,
} from "@/surfaces/github/github/api";
import {
  buildGitHubThreadManifest,
  githubConversationStorageId,
} from "@/surfaces/github/github/conversations";
import { GITHUB_DELIVERY_INSTRUCTIONS } from "@/surfaces/github/github/delivery-instructions";
import {
  collectNotificationTriggers,
  formatGitHubTurn,
  type GitHubNotificationApi,
  type GitHubNotificationTrigger,
  githubPlatformContext,
  isBeforeOrAt,
} from "@/surfaces/github/github/notifications";
import { GitHubNotificationState } from "@/surfaces/github/github/state";
import { GITHUB_SURFACE_CONTEXT } from "@/surfaces/github/runtime/context";

const log = createLogger("github-bot");
const MAX_GITHUB_COMMENT_CHARS = 60_000;

export type GitHubBotInput = {
  config: GitHubAppConfig;
  api: GitHubBotApi;
  conversations: ConversationStore;
  contextCompiler: ContextCompiler;
  provider: ModelProviderClient;
  // Shared desktop-hands capability, injected by the host when the api surface
  // runs alongside GitHub so a GitHub turn from a human whose desktop is linked
  // can reach that desktop. Absent in a standalone GitHub process.
  desktopHands?: DesktopHands;
  state?: GitHubNotificationState;
};

export type GitHubBotApi = GitHubNotificationApi & {
  currentUser(): Promise<GitHubUser>;
  listNotifications(input: {
    participating: boolean;
    limit: number;
    all?: boolean;
  }): Promise<GitHubNotification[]>;
  createIssueComment(input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }): Promise<IssueComment>;
  replyToReviewComment(input: {
    owner: string;
    repo: string;
    number: number;
    commentId: number;
    body: string;
  }): Promise<ReviewComment>;
};

export class GitHubBot {
  readonly #config: GitHubAppConfig;
  readonly #api: GitHubBotApi;
  readonly #conversations: ConversationStore;
  readonly #contextCompiler: ContextCompiler;
  readonly #provider: ModelProviderClient;
  readonly #desktopHands: DesktopHands | undefined;
  readonly #state: GitHubNotificationState;
  readonly #queue = new ThreadQueue();
  readonly #pendingTriggerKeys = new Set<string>();
  #identities: Promise<HumanIdentityConfig> | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #botUser: GitHubUser | undefined;
  #ignoreNotificationsBefore: string | undefined;

  constructor(input: GitHubBotInput) {
    this.#config = input.config;
    this.#api = input.api;
    this.#conversations = input.conversations;
    this.#contextCompiler = input.contextCompiler;
    this.#provider = input.provider;
    this.#desktopHands = input.desktopHands;
    this.#state =
      input.state ?? new GitHubNotificationState(input.config.paths.dataDir);
  }

  async start(): Promise<void> {
    const currentUser = await this.#api.currentUser();
    this.#botUser = currentUser;
    const configuredLogin = this.#config.github.login;
    if (
      configuredLogin &&
      configuredLogin.toLowerCase() !== currentUser.login.toLowerCase()
    ) {
      log.warn("configured GitHub login differs from authenticated gh user", {
        configuredLogin,
        authenticatedLogin: currentUser.login,
      });
    }
    log.info("GitHub surface starting", {
      login: configuredLogin ?? currentUser.login,
      authenticatedLogin: currentUser.login,
      pollIntervalMs: this.#config.github.pollIntervalMs,
      notificationReasons: this.#config.github.notificationReasons,
      processExistingNotifications:
        this.#config.github.processExistingNotifications,
    });
    if (!this.#config.github.processExistingNotifications) {
      this.#ignoreNotificationsBefore = new Date().toISOString();
      log.info("ignoring existing GitHub notifications on startup", {
        beforeOrAt: this.#ignoreNotificationsBefore,
      });
    }
    await this.pollOnce();
    this.#pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.#config.github.pollIntervalMs);
  }

  stop(): void {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async pollOnce(): Promise<void> {
    if (this.#polling) {
      log.warn(
        "skipping GitHub notification poll because prior poll is active",
      );
      return;
    }
    this.#polling = true;
    try {
      const bot = await this.#bot();
      const botLogin = this.#config.github.login ?? bot.login;
      const enabledReasons = new Set(this.#config.github.notificationReasons);
      const notifications = await this.#api.listNotifications({
        participating: true,
        limit: Math.min(100, this.#config.github.maxNotificationsPerPoll),
      });
      log.info("GitHub notification poll finished", {
        count: notifications.length,
        enabledReasons: [...enabledReasons],
      });
      // Collect each notification's triggers concurrently (each involves a
      // GitHub API round trip), but dispatch to the queue below in the
      // original notification order, so ordering-sensitive behavior (e.g. two
      // triggers landing on the same conversation) is unaffected by which API
      // call happens to finish first.
      const collected = await Promise.allSettled(
        notifications.map((notification) =>
          this.#collectTriggersForNotification({
            notification,
            botLogin,
            enabledReasons,
          }),
        ),
      );
      for (const [index, result] of collected.entries()) {
        const notification = notifications[index];
        if (!notification) continue;
        if (result.status === "rejected") {
          this.#logNotificationRoutingFailure(notification, result.reason);
          continue;
        }
        // Dispatch stays wrapped per-notification, matching the collect
        // step's isolation: a failure enqueueing one notification's triggers
        // must not stop the rest from dispatching.
        try {
          for (const trigger of result.value) {
            await this.#enqueueTrigger({ trigger, bot });
          }
        } catch (error) {
          this.#logNotificationRoutingFailure(notification, error);
        }
      }
    } catch (error) {
      log.error("GitHub notification poll failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#polling = false;
    }
  }

  async #collectTriggersForNotification(input: {
    notification: GitHubNotification;
    botLogin: string;
    enabledReasons: ReadonlySet<string>;
  }): Promise<GitHubNotificationTrigger[]> {
    if (
      isBeforeOrAt(
        input.notification.updated_at,
        this.#ignoreNotificationsBefore,
      )
    ) {
      return [];
    }
    return collectNotificationTriggers({
      api: this.#api,
      notification: input.notification,
      botLogin: input.botLogin,
      enabledReasons: input.enabledReasons,
    });
  }

  #logNotificationRoutingFailure(
    notification: GitHubNotification,
    error: unknown,
  ): void {
    log.warn("failed to route GitHub notification", {
      notificationId: notification.id,
      reason: notification.reason,
      subjectType: notification.subject.type,
      subjectUrl: notification.subject.url,
      error: errorMessage(error),
    });
  }

  async #enqueueTrigger(input: {
    trigger: GitHubNotificationTrigger;
    bot: GitHubUser;
  }): Promise<void> {
    if (this.#pendingTriggerKeys.has(input.trigger.key)) return;
    // Atomically claim the trigger across processes. Two bot processes can
    // otherwise both read "not processed" and both run the same trigger; the
    // claim closes that check-then-act gap so only one wins.
    const claim = await this.#state.tryClaim(input.trigger.key);
    if (claim !== "claimed") return;
    this.#pendingTriggerKeys.add(input.trigger.key);

    let enqueued = false;
    try {
      const actor = await this.#participantFromUser(input.trigger.actor);
      const conversation = await this.#loadConversation(input.trigger, actor);
      this.#queue.enqueue(
        conversation.canonicalId,
        input.trigger.key,
        async (signal) => {
          let completed = false;
          try {
            await this.#runTriggerTurn({
              trigger: input.trigger,
              bot: input.bot,
              conversation,
              actor,
              signal,
            });
            completed = true;
          } finally {
            if (completed) {
              await this.#state.markProcessed({
                key: input.trigger.key,
                notificationId: input.trigger.notificationId,
                reason: input.trigger.notificationReason,
                repository: input.trigger.repository.full_name,
                subject: `${input.trigger.thread.kind}:${input.trigger.thread.number}`,
              });
            } else {
              // The turn did not complete: release the claim so a later retry
              // can re-claim it rather than leaving it wedged until the claim
              // ages out.
              await this.#state.releaseClaim(input.trigger.key);
            }
            this.#pendingTriggerKeys.delete(input.trigger.key);
          }
        },
      );
      enqueued = true;
    } catch (error) {
      log.error("failed to enqueue GitHub trigger", {
        key: input.trigger.key,
        repository: input.trigger.repository.full_name,
        thread: `${input.trigger.thread.kind}:${input.trigger.thread.number}`,
        error: errorMessage(error),
      });
    } finally {
      if (!enqueued) {
        // We claimed but never handed work to the queue, so the queued callback
        // that would release the claim never runs. Release it here.
        this.#pendingTriggerKeys.delete(input.trigger.key);
        await this.#state.releaseClaim(input.trigger.key);
      }
    }
  }

  async #runTriggerTurn(input: {
    trigger: GitHubNotificationTrigger;
    bot: GitHubUser;
    conversation: ConversationManifest;
    actor: ConversationParticipant;
    signal: AbortSignal;
  }): Promise<void> {
    log.info("starting GitHub conversation turn", {
      conversationId: input.conversation.canonicalId,
      triggerKey: input.trigger.key,
    });
    const instructions = await this.#contextCompiler.compile({
      conversation: input.conversation,
      deliveryInstructions: GITHUB_DELIVERY_INSTRUCTIONS,
      skillHintQuery: skillHintQuery(input.trigger),
    });
    const lease = this.#leaseDesktopHands(input.actor.identityId, input.signal);
    const request: ProviderTurnRequest = {
      conversationId: input.conversation.canonicalId,
      instructions,
      input: formatGitHubTurn({
        trigger: input.trigger,
        actorIdentityId: input.actor.identityId,
      }),
      sessionMode: "persistent",
      platformContext: githubPlatformContext({
        trigger: input.trigger,
        bot: input.bot,
      }),
      accountRouting: accountRoutingForParticipant(input.actor),
      surfaceContext: GITHUB_SURFACE_CONTEXT,
      memoryContext: buildMemoryContext({
        dataDir: this.#config.paths.dataDir,
        conversation: input.conversation,
        participants: input.conversation.participants,
      }),
      ...(lease ? { localToolBroker: lease.ticket } : {}),
      signal: input.signal,
    };
    try {
      let response: ProviderTurnResponse;
      try {
        response = await this.#provider.generateTurn(request);
      } catch (error) {
        if (error instanceof ProviderTurnError && error.deliverySideEffects) {
          log.warn("GitHub provider turn failed after delivery side effect", {
            conversationId: input.conversation.canonicalId,
            triggerKey: input.trigger.key,
            reason: error.reason,
            providerError: error.message,
          });
          return;
        }
        throw error;
      }
      log.info("GitHub provider turn finished", {
        conversationId: input.conversation.canonicalId,
        triggerKey: input.trigger.key,
        responseLength: response.text.length,
        deliverySideEffects: response.deliverySideEffects,
      });
      await this.#sendProviderResponse({
        trigger: input.trigger,
        response,
      });
    } finally {
      lease?.revoke();
    }
  }

  // Leases hands on the actor's desktop when their machine is linked, so a
  // GitHub turn can read files and run shell commands there alongside its
  // server-side tools.
  #leaseDesktopHands(
    identityId: string | undefined,
    signal: AbortSignal,
  ): DesktopHandsLease | undefined {
    return leaseDesktopHands({
      hands: this.#desktopHands,
      identityId,
      signal,
    });
  }

  async #sendProviderResponse(input: {
    trigger: GitHubNotificationTrigger;
    response: ProviderTurnResponse;
  }): Promise<void> {
    if (input.response.deliverySideEffects) return;
    const content = input.response.text.trim();
    if (!content) return;

    const chunks = chunkGitHubComment(content);
    let deliveredChunks = 0;
    for (const [index, chunk] of chunks.entries()) {
      try {
        if (index === 0 && input.trigger.source.kind === "review_comment") {
          await this.#api.replyToReviewComment({
            owner: input.trigger.thread.owner,
            repo: input.trigger.thread.repo,
            number: input.trigger.thread.number,
            commentId: input.trigger.source.id,
            body: chunk,
          });
          deliveredChunks += 1;
          continue;
        }
        await this.#api.createIssueComment({
          owner: input.trigger.thread.owner,
          repo: input.trigger.thread.repo,
          number: input.trigger.thread.number,
          body: chunk,
        });
        deliveredChunks += 1;
      } catch (error) {
        if (deliveredChunks === 0) throw error;
        log.error("GitHub response partially delivered; suppressing retry", {
          triggerKey: input.trigger.key,
          deliveredChunks,
          totalChunks: chunks.length,
          error: errorMessage(error),
        });
        return;
      }
    }
  }

  async #loadConversation(
    trigger: GitHubNotificationTrigger,
    starter: ConversationParticipant,
  ): Promise<ConversationManifest> {
    const storageId = githubConversationStorageId(trigger.thread);
    const manifest = await this.#conversations.getOrCreate({
      storageId,
      fallback: buildGitHubThreadManifest({
        thread: trigger.thread,
        starter,
      }),
    });
    return this.#conversations.addParticipant({
      storageId,
      manifest,
      participant: starter,
    });
  }

  async #participantFromUser(
    user: GitHubUser,
  ): Promise<ConversationParticipant> {
    const participant: ConversationParticipant = {
      platform: "github",
      platformUserId: String(user.id),
      username: user.login,
      joinedAt: new Date().toISOString(),
    };
    if (user.name) participant.displayName = user.name;
    const identities = await this.#loadIdentities();
    const identity = findHumanIdentity({
      identities,
      platform: "github",
      platformUserId: participant.platformUserId,
      username: participant.username,
    });
    if (!identity) return participant;
    return { ...participant, identityId: identity.id };
  }

  #loadIdentities(): Promise<HumanIdentityConfig> {
    this.#identities ??= loadHumanIdentities(this.#config.paths.configDirs);
    return this.#identities;
  }

  async #bot(): Promise<GitHubUser> {
    if (this.#botUser) return this.#botUser;
    this.#botUser = await this.#api.currentUser();
    return this.#botUser;
  }
}

function accountRoutingForParticipant(
  participant: ConversationParticipant,
): PiAccountRoutingRequest {
  const request: PiAccountRoutingRequest = {};
  if (participant.identityId) request.identityId = participant.identityId;
  return request;
}

function skillHintQuery(trigger: GitHubNotificationTrigger): string {
  if (trigger.kind === "review_requested") {
    return `GitHub pull request review ${trigger.repository.full_name}#${trigger.thread.number}`;
  }
  return `GitHub mention ${trigger.repository.full_name}#${trigger.thread.number}`;
}

function chunkGitHubComment(text: string): string[] {
  if (text.length <= MAX_GITHUB_COMMENT_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const next = remaining.slice(0, MAX_GITHUB_COMMENT_CHARS);
    const splitAt = findCommentSplitPoint(next);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function findCommentSplitPoint(value: string): number {
  const paragraph = value.lastIndexOf("\n\n");
  if (paragraph > 1_000) return paragraph;
  const newline = value.lastIndexOf("\n");
  if (newline > 1_000) return newline;
  const space = value.lastIndexOf(" ");
  if (space > 1_000) return space;
  return value.length;
}
