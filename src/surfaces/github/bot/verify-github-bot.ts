import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import type {
  DesktopHands,
  DesktopHandsLease,
} from "@/lib/provider/desktop-hands";
import {
  type LocalToolBroker,
  type ModelProviderClient,
  type ProviderProbe,
  ProviderTurnError,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import { assertEqual, withTempDir } from "@/lib/verification/harness";
import { GitHubBot, type GitHubBotApi } from "@/surfaces/github/bot/github-bot";
import type { GitHubAppConfig } from "@/surfaces/github/config";
import type {
  GitHubNotification,
  GitHubRepository,
  GitHubUser,
  Issue,
  IssueComment,
  IssueEvent,
  PullRequest,
  ReviewComment,
} from "@/surfaces/github/github/api";
import { GitHubNotificationState } from "@/surfaces/github/github/state";
import { GITHUB_SURFACE_CONTEXT } from "@/surfaces/github/runtime/context";

async function verifyProviderSideEffectFailureIsCheckpointed(): Promise<void> {
  await withBotFixture(async ({ bot, state, api }) => {
    api.notification = mentionNotification();
    api.issueComment = issueComment("hey @sandi-witch please check this");
    bot.provider = providerThrowingSideEffectError();

    await bot.instance.pollOnce();
    await waitFor("provider side-effect failure checkpoint", () =>
      state.hasProcessed("github:mention:issue-comment:9001"),
    );
    assertEqual(api.createdIssueComments.length, 0, "auto comments");
  });
}

async function verifyPartialAutoDeliveryIsCheckpointed(): Promise<void> {
  await withBotFixture(async ({ bot, state, api }) => {
    api.notification = mentionNotification();
    api.issueComment = issueComment("hey @sandi-witch please check this");
    api.failAfterIssueComments = 1;
    bot.provider = providerReturningText(`${"x".repeat(61_000)}\nsecond`);

    await bot.instance.pollOnce();
    await waitFor("partial auto delivery checkpoint", () =>
      state.hasProcessed("github:mention:issue-comment:9001"),
    );
    assertEqual(api.createdIssueComments.length, 1, "delivered chunks");
  });
}

async function verifyMappedActorLeasesDesktopHands(): Promise<void> {
  await withBotFixture(async ({ bot, state, api, config }) => {
    await seedGitHubIdentity(config, {
      identityId: "jess-human",
      login: "jess",
      id: "42",
    });
    api.notification = mentionNotification();
    api.issueComment = issueComment("hey @sandi-witch please check this");

    const ticket: LocalToolBroker = {
      url: "http://127.0.0.1:7",
      token: "desktop-ticket",
    };
    const leasedFor: string[] = [];
    let revoked = 0;
    bot.desktopHands = {
      leaseForIdentity(input): DesktopHandsLease {
        leasedFor.push(input.identityId);
        return {
          ticket,
          revoke() {
            revoked += 1;
          },
        };
      },
    };
    const requests: ProviderTurnRequest[] = [];
    bot.provider = providerCapturing(requests, "ok");

    await bot.instance.pollOnce();
    await waitFor("mapped-actor turn processed", () =>
      state.hasProcessed("github:mention:issue-comment:9001"),
    );

    assertEqual(leasedFor.length, 1, "lease attempts");
    assertEqual(leasedFor[0], "jess-human", "leased identity");
    assertEqual(requests.length, 1, "provider turns");
    assertEqual(
      requests[0]?.localToolBroker?.token,
      ticket.token,
      "request carries the leased desktop ticket",
    );
    assertEqual(revoked, 1, "lease revoked exactly once");
  });
}

async function verifyUnmappedActorRunsWithoutDesktopHands(): Promise<void> {
  await withBotFixture(async ({ bot, state, api }) => {
    api.notification = mentionNotification();
    api.issueComment = issueComment("hey @sandi-witch please check this");

    let leaseCalls = 0;
    bot.desktopHands = {
      leaseForIdentity(): DesktopHandsLease | undefined {
        leaseCalls += 1;
        return undefined;
      },
    };
    const requests: ProviderTurnRequest[] = [];
    bot.provider = providerCapturing(requests, "ok");

    await bot.instance.pollOnce();
    await waitFor("unmapped-actor turn processed", () =>
      state.hasProcessed("github:mention:issue-comment:9001"),
    );

    // An unmapped GitHub actor has no identity to lease against, so the bot must
    // not even ask for a desktop and the turn runs with server hands only.
    assertEqual(leaseCalls, 0, "lease attempts for an unmapped actor");
    assertEqual(requests.length, 1, "provider turns");
    assertEqual(
      requests[0]?.localToolBroker,
      undefined,
      "request omits a desktop ticket",
    );
  });
}

async function seedGitHubIdentity(
  config: GitHubAppConfig,
  input: { identityId: string; login: string; id: string },
): Promise<void> {
  const dir = join(config.paths.configDir, "identities");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "humans.json"),
    JSON.stringify({
      version: 1,
      humans: [
        {
          id: input.identityId,
          displayName: input.login,
          platforms: { github: { id: input.id, login: input.login } },
        },
      ],
    }),
    "utf8",
  );
}

function providerCapturing(
  sink: ProviderTurnRequest[],
  text: string,
): ModelProviderClient {
  return {
    async probe(): Promise<ProviderProbe> {
      return passingProbe();
    },
    async generateTurn(
      request: ProviderTurnRequest,
    ): Promise<ProviderTurnResponse> {
      sink.push(request);
      return { text, deliverySideEffects: false, raw: null };
    },
  };
}

async function withBotFixture(
  run: (fixture: {
    bot: MutableBotFixture;
    state: GitHubNotificationState;
    api: FakeGitHubApi;
    config: GitHubAppConfig;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir("sandi-github-bot-", async (dataDir) => {
    const config = testConfig(dataDir);
    const api = new FakeGitHubApi();
    const state = new GitHubNotificationState(dataDir);
    const fixture: MutableBotFixture = {
      provider: providerReturningText("ok"),
      desktopHands: undefined,
      get instance() {
        return new GitHubBot({
          config,
          api,
          conversations: new ConversationStore(config.paths.dataDir),
          contextCompiler: new ContextCompiler(
            config.paths.configDirs,
            config.paths.dataDir,
            GITHUB_SURFACE_CONTEXT,
          ),
          provider: this.provider,
          state,
          ...(this.desktopHands ? { desktopHands: this.desktopHands } : {}),
        });
      },
    };
    await run({ bot: fixture, state, api, config });
  });
}

type MutableBotFixture = {
  provider: ModelProviderClient;
  desktopHands: DesktopHands | undefined;
  readonly instance: GitHubBot;
};

class FakeGitHubApi implements GitHubBotApi {
  notification: GitHubNotification | undefined;
  issueComment: IssueComment | undefined;
  failAfterIssueComments: number | undefined;
  readonly createdIssueComments: string[] = [];

  async currentUser(): Promise<GitHubUser> {
    return githubUser("sandi-witch", 282067348);
  }

  async listNotifications(): Promise<GitHubNotification[]> {
    return this.notification ? [this.notification] : [];
  }

  async getIssueCommentByUrl(): Promise<IssueComment> {
    if (!this.issueComment) throw new Error("missing issue comment");
    return this.issueComment;
  }

  async getReviewCommentByUrl(): Promise<ReviewComment> {
    throw new Error("unexpected review comment fetch");
  }

  async getPullRequest(): Promise<PullRequest> {
    return pullRequest();
  }

  async getIssue(): Promise<Issue> {
    return issue();
  }

  async listIssueEvents(): Promise<IssueEvent[]> {
    return [];
  }

  async createIssueComment(input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }): Promise<IssueComment> {
    if (
      this.failAfterIssueComments !== undefined &&
      this.createdIssueComments.length >= this.failAfterIssueComments
    ) {
      throw new Error("simulated comment failure");
    }
    this.createdIssueComments.push(input.body);
    return issueComment(input.body, githubUser("sandi-witch", 282067348));
  }

  async replyToReviewComment(): Promise<ReviewComment> {
    throw new Error("unexpected review comment reply");
  }
}

function providerThrowingSideEffectError(): ModelProviderClient {
  return {
    async probe(): Promise<ProviderProbe> {
      return passingProbe();
    },
    async generateTurn(): Promise<ProviderTurnResponse> {
      throw new ProviderTurnError({
        message: "simulated provider failure after delivery",
        reason: "unknown",
        exitCode: 1,
        stderr: "simulated",
        deliverySideEffects: true,
      });
    },
  };
}

function providerReturningText(text: string): ModelProviderClient {
  return {
    async probe(): Promise<ProviderProbe> {
      return passingProbe();
    },
    async generateTurn(
      _request: ProviderTurnRequest,
    ): Promise<ProviderTurnResponse> {
      return {
        text,
        deliverySideEffects: false,
        raw: null,
      };
    },
  };
}

function passingProbe(): ProviderProbe {
  return {
    command: { ok: true, detail: "ok" },
    version: { ok: true, detail: "ok" },
    model: { ok: true, detail: "ok" },
  };
}

function testConfig(dataDir: string): GitHubAppConfig {
  return {
    pi: {
      command: "pi",
      packageManifestPath: join(dataDir, "pi-packages.json"),
      sessionDir: join(dataDir, "pi-sessions"),
      tokenUsagePath: join(dataDir, "provider-usage", "tokens.jsonl"),
      extensionPaths: [],
      timeoutMs: 1_000,
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    paths: {
      dataDir,
      configDir: join(dataDir, "config"),
      privateConfigDir: join(dataDir, "private-config"),
      configDirs: [join(dataDir, "private-config"), join(dataDir, "config")],
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    github: {
      ghCommand: "gh",
      pollIntervalMs: 60_000,
      ghTimeoutMs: 120_000,
      maxNotificationsPerPoll: 50,
      notificationReasons: ["mention", "review_requested"],
      processExistingNotifications: true,
    },
  };
}

function mentionNotification(): GitHubNotification {
  return {
    id: "n1",
    unread: true,
    reason: "mention",
    updated_at: "2026-06-15T00:02:00Z",
    last_read_at: null,
    url: "https://api.github.com/notifications/threads/n1",
    repository: repository(),
    subject: {
      title: "Mention Sandi",
      url: "https://api.github.com/repos/earendil-works/sandi/issues/12",
      latest_comment_url:
        "https://api.github.com/repos/earendil-works/sandi/issues/comments/9001",
      type: "Issue",
    },
  };
}

function issueComment(
  body: string,
  user = githubUser("jess", 42),
): IssueComment {
  return {
    id: 9001,
    body,
    html_url:
      "https://github.com/earendil-works/sandi/issues/12#issuecomment-9001",
    created_at: "2026-06-15T00:01:00Z",
    updated_at: "2026-06-15T00:02:00Z",
    user,
  };
}

function issue(): Issue {
  return {
    number: 12,
    state: "open",
    title: "Mention Sandi",
    body: "hello @sandi-witch",
    html_url: "https://github.com/earendil-works/sandi/issues/12",
    user: githubUser("jess", 42),
  };
}

function pullRequest(): PullRequest {
  return {
    number: 99,
    state: "open",
    title: "Build GitHub surface",
    body: "please review",
    html_url: "https://github.com/earendil-works/sandi/pull/99",
    diff_url: "https://github.com/earendil-works/sandi/pull/99.diff",
    patch_url: "https://github.com/earendil-works/sandi/pull/99.patch",
    draft: false,
    user: githubUser("jess", 42),
    requested_reviewers: [githubUser("sandi-witch", 282067348)],
    base: {
      ref: "main",
      sha: "base",
      repo: repository(),
    },
    head: {
      ref: "feature",
      sha: "head",
      repo: repository(),
    },
  };
}

function repository(): GitHubRepository {
  return {
    id: 1,
    name: "sandi",
    full_name: "earendil-works/sandi",
    html_url: "https://github.com/earendil-works/sandi",
    default_branch: "main",
    owner: {
      id: 100,
      login: "earendil-works",
      html_url: "https://github.com/earendil-works",
      type: "Organization",
    },
  };
}

function githubUser(login: string, id: number): GitHubUser {
  return {
    id,
    login,
    html_url: `https://github.com/${login}`,
    type: "User",
  };
}

await verifyProviderSideEffectFailureIsCheckpointed();
await verifyPartialAutoDeliveryIsCheckpointed();
await verifyMappedActorLeasesDesktopHands();
await verifyUnmappedActorRunsWithoutDesktopHands();

console.log("GitHub bot verification passed");

async function waitFor(
  label: string,
  condition: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await condition()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
