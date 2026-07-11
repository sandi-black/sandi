import { mapSettledWithLimit } from "@/lib/async-pool";
import type { ContextCompiler } from "@/lib/context/context-compiler";
import { buildMemoryContext } from "@/lib/context/memory";
import type { ConversationStore } from "@/lib/conversations/store";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { errorMessage } from "@/lib/errors";
import {
  findHumanIdentityByPlatformId,
  HumanIdentityStore,
} from "@/lib/identity/resolver";
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
import {
  CLAIM_RENEWAL_MS,
  CLAIM_STALE_MS,
  GitHubNotificationState,
  type TriggerClaim,
} from "@/surfaces/github/github/state";
import { GITHUB_SURFACE_CONTEXT } from "@/surfaces/github/runtime/context";

const log = createLogger("github-bot");
const MAX_GITHUB_COMMENT_CHARS = 60_000;
// Each trigger collection spawns one or two `gh` subprocesses; a full poll of
// 100 notifications mapped without a cap would burst-spawn enough concurrent
// processes to trip GitHub's secondary rate limiting.
const MAX_CONCURRENT_TRIGGER_COLLECTIONS = 6;
const CLAIM_RENEWAL_RETRY_MS = 30_000;

export type GitHubClaimLeaseScheduler = {
  now(): number;
  schedule(delayMs: number, task: () => Promise<void>): { cancel(): void };
};

export type GitHubClaimLeaseRuntime = {
  scheduler: GitHubClaimLeaseScheduler;
  staleMs: number;
  renewalMs: number;
  retryMs: number;
  expirySafetyMs: number;
};

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
  claimLease?: GitHubClaimLeaseRuntime;
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
  readonly #identities: HumanIdentityStore;
  readonly #claimLease: GitHubClaimLeaseRuntime;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #botUser: GitHubUser | undefined;
  #ignoreNotificationsBefore: string | undefined;
  #startPromise: Promise<void> | undefined;
  #stopped = false;

  constructor(input: GitHubBotInput) {
    this.#config = input.config;
    this.#api = input.api;
    this.#conversations = input.conversations;
    this.#contextCompiler = input.contextCompiler;
    this.#provider = input.provider;
    this.#desktopHands = input.desktopHands;
    this.#identities = new HumanIdentityStore(input.config.paths.configDirs, 0);
    this.#state =
      input.state ?? new GitHubNotificationState(input.config.paths.dataDir);
    this.#claimLease = validateClaimLeaseRuntime(
      input.claimLease ?? defaultClaimLeaseRuntime(),
    );
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#stopped = false;
    const startPromise = this.#startOnce();
    this.#startPromise = startPromise;
    return startPromise;
  }

  async #startOnce(): Promise<void> {
    const currentUser = await this.#api.currentUser();
    if (this.#stopped) throw new Error("GitHub bot stopped while starting");
    this.#botUser = currentUser;
    const configuredLogin = this.#config.github.login;
    if (
      configuredLogin &&
      configuredLogin.toLowerCase() !== currentUser.login.toLowerCase()
    ) {
      throw new Error(
        `configured GitHub login ${configuredLogin} does not match authenticated gh user ${currentUser.login}`,
      );
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
    if (this.#stopped) throw new Error("GitHub bot stopped while starting");
    this.#pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.#config.github.pollIntervalMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async pollOnce(): Promise<void> {
    if (this.#stopped) return;
    if (this.#polling) {
      log.warn(
        "skipping GitHub notification poll because prior poll is active",
      );
      return;
    }
    this.#polling = true;
    try {
      const bot = await this.#bot();
      const botLogin = bot.login;
      const enabledReasons = new Set(this.#config.github.notificationReasons);
      const notifications = await this.#api.listNotifications({
        participating: true,
        limit: Math.min(100, this.#config.github.maxNotificationsPerPoll),
      });
      if (this.#stopped) return;
      log.info("GitHub notification poll finished", {
        count: notifications.length,
        enabledReasons: [...enabledReasons],
      });
      // Collect each notification's triggers concurrently (each involves a
      // GitHub API round trip), but dispatch to the queue below in the
      // original notification order, so ordering-sensitive behavior (e.g. two
      // triggers landing on the same conversation) is unaffected by which API
      // call happens to finish first. Concurrency is capped: every API call
      // here is a `gh` subprocess, and an uncapped map over a full poll (up
      // to 100 notifications) would burst-spawn enough concurrent processes
      // to trip GitHub's abuse rate limiting.
      const collected = await mapSettledWithLimit(
        notifications,
        MAX_CONCURRENT_TRIGGER_COLLECTIONS,
        (notification) =>
          this.#collectTriggersForNotification({
            notification,
            botLogin,
            enabledReasons,
          }),
      );
      for (const [index, result] of collected.entries()) {
        if (this.#stopped) return;
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
    this.#pendingTriggerKeys.add(input.trigger.key);

    let enqueued = false;
    try {
      const actor = await this.#participantFromUser(input.trigger.actor);
      const conversation = await this.#loadConversation(input.trigger, actor);
      this.#queue.enqueue(
        conversation.canonicalId,
        input.trigger.key,
        async (signal) => {
          try {
            // Claim only when the queued job starts. A claim made while another
            // turn is ahead of this one could expire before this callback runs.
            const confirmedAt = this.#claimLease.scheduler.now();
            const claimResult = await this.#state.tryClaim(input.trigger.key);
            if (typeof claimResult === "string") return;
            const { claim } = claimResult;
            const lease = new TriggerClaimLease({
              state: this.#state,
              claim,
              confirmedAt,
              runtime: this.#claimLease,
            });
            let completed = false;
            try {
              lease.start();
              const turnSignal = AbortSignal.any([signal, lease.signal]);
              turnSignal.throwIfAborted();
              await this.#runTriggerTurn({
                trigger: input.trigger,
                bot: input.bot,
                conversation,
                actor,
                signal: turnSignal,
              });
              turnSignal.throwIfAborted();
              completed = true;
            } finally {
              try {
                if (completed) {
                  const marked = await this.#state.markProcessed(
                    {
                      key: input.trigger.key,
                      notificationId: input.trigger.notificationId,
                      reason: input.trigger.notificationReason,
                      repository: input.trigger.repository.full_name,
                      subject: `${input.trigger.thread.kind}:${input.trigger.thread.number}`,
                    },
                    claim,
                  );
                  if (!marked) {
                    log.warn(
                      "GitHub trigger completed after losing its claim",
                      {
                        key: input.trigger.key,
                      },
                    );
                  }
                } else {
                  // The turn did not complete: release the claim so a later
                  // poll can retry without waiting for the lease to age out.
                  await this.#state.releaseClaim(claim);
                }
              } finally {
                lease.stop();
              }
            }
          } finally {
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
        this.#pendingTriggerKeys.delete(input.trigger.key);
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
    input.signal.throwIfAborted();
    log.info("starting GitHub conversation turn", {
      conversationId: input.conversation.canonicalId,
      triggerKey: input.trigger.key,
    });
    const instructions = await this.#contextCompiler.compile({
      conversation: input.conversation,
      deliveryInstructions: GITHUB_DELIVERY_INSTRUCTIONS,
      skillHintQuery: skillHintQuery(input.trigger),
    });
    input.signal.throwIfAborted();
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
      input.signal.throwIfAborted();
      log.info("GitHub provider turn finished", {
        conversationId: input.conversation.canonicalId,
        triggerKey: input.trigger.key,
        responseLength: response.text.length,
        deliverySideEffects: response.deliverySideEffects,
      });
      await this.#sendProviderResponse({
        trigger: input.trigger,
        response,
        signal: input.signal,
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
    signal: AbortSignal;
  }): Promise<void> {
    if (input.response.deliverySideEffects) return;
    const content = input.response.text.trim();
    if (!content) return;

    const chunks = chunkGitHubComment(content);
    let deliveredChunks = 0;
    for (const [index, chunk] of chunks.entries()) {
      try {
        input.signal.throwIfAborted();
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
    const identities = await this.#identities.load();
    const identity = findHumanIdentityByPlatformId({
      identities,
      platform: "github",
      platformUserId: participant.platformUserId,
    });
    if (!identity) return participant;
    return { ...participant, identityId: identity.id };
  }

  async #bot(): Promise<GitHubUser> {
    if (this.#botUser) return this.#botUser;
    this.#botUser = await this.#api.currentUser();
    return this.#botUser;
  }
}

class TriggerClaimLease {
  readonly #state: GitHubNotificationState;
  readonly #claim: TriggerClaim;
  readonly #runtime: GitHubClaimLeaseRuntime;
  readonly #controller = new AbortController();
  #confirmedAt: number;
  #renewalTimer: { cancel(): void } | undefined;
  #expiryTimer: { cancel(): void } | undefined;
  #stopped = true;

  constructor(input: {
    state: GitHubNotificationState;
    claim: TriggerClaim;
    confirmedAt: number;
    runtime: GitHubClaimLeaseRuntime;
  }) {
    this.#state = input.state;
    this.#claim = input.claim;
    this.#confirmedAt = input.confirmedAt;
    this.#runtime = input.runtime;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleExpiry();
    this.#scheduleRenewal(this.#runtime.renewalMs);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#renewalTimer?.cancel();
    this.#renewalTimer = undefined;
    this.#expiryTimer?.cancel();
    this.#expiryTimer = undefined;
  }

  #scheduleExpiry(): void {
    this.#expiryTimer?.cancel();
    const deadline = this.#expiryDeadline();
    const delayMs = Math.max(0, deadline - this.#runtime.scheduler.now());
    this.#expiryTimer = this.#runtime.scheduler.schedule(delayMs, async () => {
      this.#expiryTimer = undefined;
      this.#abort(
        new Error(
          "GitHub trigger claim could not be confirmed before its safety deadline",
        ),
      );
    });
  }

  #scheduleRenewal(delayMs: number): void {
    this.#renewalTimer?.cancel();
    this.#renewalTimer = this.#runtime.scheduler.schedule(delayMs, async () => {
      this.#renewalTimer = undefined;
      await this.#renew();
    });
  }

  async #renew(): Promise<void> {
    if (this.#stopped) return;
    const confirmedAt = this.#runtime.scheduler.now();
    try {
      const renewed = await this.#state.renewClaim(this.#claim);
      if (this.#stopped) return;
      if (!renewed) {
        this.#abort(new Error("GitHub trigger claim ownership was lost"));
        return;
      }
      // The attempt start is a conservative lower bound for the time written
      // to disk, so the local deadline can never outlive the persisted lease.
      this.#confirmedAt = confirmedAt;
      this.#scheduleExpiry();
      this.#scheduleRenewal(
        Math.max(
          0,
          confirmedAt + this.#runtime.renewalMs - this.#runtime.scheduler.now(),
        ),
      );
    } catch (error) {
      if (this.#stopped) return;
      log.error("failed to renew GitHub trigger claim", {
        key: this.#claim.key,
        error: errorMessage(error),
      });
      const remainingMs =
        this.#expiryDeadline() - this.#runtime.scheduler.now();
      if (remainingMs <= 1) {
        this.#abort(
          new Error("GitHub trigger claim renewal failed until its deadline", {
            cause: error,
          }),
        );
        return;
      }
      this.#scheduleRenewal(Math.min(this.#runtime.retryMs, remainingMs - 1));
    }
  }

  #expiryDeadline(): number {
    return (
      this.#confirmedAt + this.#runtime.staleMs - this.#runtime.expirySafetyMs
    );
  }

  #abort(reason: Error): void {
    if (this.#stopped) return;
    this.stop();
    this.#controller.abort(reason);
  }
}

function defaultClaimLeaseRuntime(): GitHubClaimLeaseRuntime {
  return {
    scheduler: nodeClaimLeaseScheduler,
    staleMs: CLAIM_STALE_MS,
    renewalMs: CLAIM_RENEWAL_MS,
    retryMs: CLAIM_RENEWAL_RETRY_MS,
    // This leaves a full normal renewal interval for an aborted provider or
    // GitHub command to settle while the persisted claim is still exclusive.
    expirySafetyMs: CLAIM_RENEWAL_MS,
  };
}

const nodeClaimLeaseScheduler: GitHubClaimLeaseScheduler = {
  now: Date.now,
  schedule(delayMs, task) {
    const timer = setTimeout(() => {
      void task().catch((error: unknown) => {
        log.error("GitHub claim lease timer failed", {
          error: errorMessage(error),
        });
      });
    }, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

function validateClaimLeaseRuntime(
  runtime: GitHubClaimLeaseRuntime,
): GitHubClaimLeaseRuntime {
  const timings: Array<readonly [string, number]> = [
    ["staleMs", runtime.staleMs],
    ["renewalMs", runtime.renewalMs],
    ["retryMs", runtime.retryMs],
    ["expirySafetyMs", runtime.expirySafetyMs],
  ];
  for (const [name, value] of timings) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`GitHub claim lease ${name} must be a positive integer`);
    }
  }
  const confirmedLifetimeMs = runtime.staleMs - runtime.expirySafetyMs;
  if (confirmedLifetimeMs <= 0) {
    throw new Error(
      "GitHub claim lease expirySafetyMs must be smaller than staleMs",
    );
  }
  if (runtime.renewalMs >= confirmedLifetimeMs) {
    throw new Error(
      "GitHub claim lease renewalMs must be shorter than its confirmed lifetime",
    );
  }
  if (runtime.retryMs >= confirmedLifetimeMs) {
    throw new Error(
      "GitHub claim lease retryMs must be shorter than its confirmed lifetime",
    );
  }
  return runtime;
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
