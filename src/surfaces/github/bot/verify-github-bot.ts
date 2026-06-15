import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import {
  type ModelProviderClient,
  type ProviderProbe,
  ProviderTurnError,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
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

async function withBotFixture(
  run: (fixture: {
    bot: MutableBotFixture;
    state: GitHubNotificationState;
    api: FakeGitHubApi;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "sandi-github-bot-"));
  try {
    const config = testConfig(dataDir);
    const api = new FakeGitHubApi();
    const state = new GitHubNotificationState(dataDir);
    const fixture: MutableBotFixture = {
      provider: providerReturningText("ok"),
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
        });
      },
    };
    await run({ bot: fixture, state, api });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

type MutableBotFixture = {
  provider: ModelProviderClient;
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
      skillsRoot: join(dataDir, "skills"),
    },
    paths: {
      dataDir,
      configDir: join(dataDir, "config"),
      privateConfigDir: join(dataDir, "private-config"),
      configDirs: [join(dataDir, "private-config"), join(dataDir, "config")],
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  throw new Error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
