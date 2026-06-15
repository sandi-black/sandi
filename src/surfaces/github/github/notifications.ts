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
import { parseRepositoryFullName } from "@/surfaces/github/github/api";
import type {
  GitHubThreadKind,
  GitHubThreadRef,
} from "@/surfaces/github/github/conversations";

export type GitHubTriggerKind = "mention" | "review_requested";

export type GitHubTriggerSource =
  | {
      kind: "issue_comment";
      id: number;
      htmlUrl: string;
      createdAt: string;
      updatedAt: string;
      body: string;
    }
  | {
      kind: "review_comment";
      id: number;
      htmlUrl: string;
      createdAt: string;
      updatedAt: string;
      body: string;
      path: string;
      diffHunk?: string;
    }
  | {
      kind: "review_request";
      id: number;
      createdAt: string;
    }
  | {
      kind: "subject_body";
      htmlUrl: string;
      updatedAt: string;
      body: string;
    };

export type GitHubNotificationTrigger = {
  key: string;
  kind: GitHubTriggerKind;
  notificationId: string;
  notificationReason: string;
  notificationUpdatedAt: string;
  repository: GitHubRepository;
  thread: GitHubThreadRef;
  actor: GitHubUser;
  source: GitHubTriggerSource;
};

export type GitHubNotificationApi = {
  getIssueCommentByUrl(url: string): Promise<IssueComment>;
  getReviewCommentByUrl(url: string): Promise<ReviewComment>;
  getPullRequest(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<PullRequest>;
  getIssue(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<Issue>;
  listIssueEvents(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<IssueEvent[]>;
};

export async function collectNotificationTriggers(input: {
  api: GitHubNotificationApi;
  notification: GitHubNotification;
  botLogin: string;
  enabledReasons: ReadonlySet<string>;
}): Promise<GitHubNotificationTrigger[]> {
  const reason = input.notification.reason;
  if (!input.enabledReasons.has(reason)) return [];

  const thread = threadFromNotification(input.notification);
  if (!thread) return [];

  if (reason === "mention") {
    return collectMentionTriggers({
      ...input,
      thread,
    });
  }
  if (reason === "review_requested") {
    return collectReviewRequestTriggers({
      ...input,
      thread,
    });
  }
  return [];
}

export function bodyMentionsLogin(
  body: string | null | undefined,
  login: string,
): boolean {
  if (!body) return false;
  const escaped = escapeRegExp(login);
  return new RegExp(`(^|[^A-Za-z0-9_-])@${escaped}\\b`, "i").test(body);
}

export function formatGitHubTurn(input: {
  trigger: GitHubNotificationTrigger;
  actorIdentityId?: string | undefined;
}): string {
  const trigger = input.trigger;
  return [
    `<github_notification actor="${trigger.actor.login}" github_user_id="${trigger.actor.id}" trigger_kind="${trigger.kind}">`,
    "<metadata>",
    ...accountRoutingProvenanceLines({
      source:
        trigger.kind === "review_requested"
          ? "github_review_request"
          : "github_mention",
      githubUserId: String(trigger.actor.id),
      login: trigger.actor.login,
      identityId: input.actorIdentityId,
    }),
    formatGitHubMetadata(trigger),
    "</metadata>",
    "",
    formatGitHubPrompt(trigger),
    "</github_notification>",
  ].join("\n");
}

export function githubPlatformContext(input: {
  trigger: GitHubNotificationTrigger;
  bot: GitHubUser;
}): Record<string, unknown> {
  const trigger = input.trigger;
  return {
    platform: "github",
    bot: {
      id: input.bot.id,
      login: input.bot.login,
      htmlUrl: input.bot.html_url,
    },
    repository: {
      owner: trigger.thread.owner,
      repo: trigger.thread.repo,
      fullName: trigger.repository.full_name,
      htmlUrl: trigger.repository.html_url,
      defaultBranch: trigger.repository.default_branch,
    },
    thread: {
      kind: trigger.thread.kind,
      number: trigger.thread.number,
      title: trigger.thread.title,
      htmlUrl: trigger.thread.htmlUrl,
    },
    trigger: {
      key: trigger.key,
      kind: trigger.kind,
      notificationId: trigger.notificationId,
      notificationReason: trigger.notificationReason,
      notificationUpdatedAt: trigger.notificationUpdatedAt,
      source: trigger.source,
      actor: {
        id: trigger.actor.id,
        login: trigger.actor.login,
        htmlUrl: trigger.actor.html_url,
      },
    },
  };
}

function formatGitHubMetadata(trigger: GitHubNotificationTrigger): string {
  const lines = [
    `time: ${new Date().toISOString()}`,
    `notification_id: ${trigger.notificationId}`,
    `notification_reason: ${trigger.notificationReason}`,
    `notification_updated_at: ${trigger.notificationUpdatedAt}`,
    `repository: ${trigger.repository.full_name}`,
    `repository_url: ${trigger.repository.html_url}`,
    `thread_kind: ${trigger.thread.kind}`,
    `thread_number: ${trigger.thread.number}`,
    `thread_title: ${trigger.thread.title}`,
    `thread_url: ${trigger.thread.htmlUrl}`,
    `actor_github_user_id: ${trigger.actor.id}`,
    `actor_login: ${trigger.actor.login}`,
  ];
  if (trigger.source.kind === "issue_comment") {
    lines.push(
      `source_kind: issue_comment`,
      `comment_id: ${trigger.source.id}`,
      `comment_url: ${trigger.source.htmlUrl}`,
      `comment_created_at: ${trigger.source.createdAt}`,
      `comment_updated_at: ${trigger.source.updatedAt}`,
    );
  }
  if (trigger.source.kind === "review_comment") {
    lines.push(
      `source_kind: review_comment`,
      `review_comment_id: ${trigger.source.id}`,
      `review_comment_url: ${trigger.source.htmlUrl}`,
      `review_comment_path: ${trigger.source.path}`,
      `review_comment_created_at: ${trigger.source.createdAt}`,
      `review_comment_updated_at: ${trigger.source.updatedAt}`,
    );
  }
  if (trigger.source.kind === "review_request") {
    lines.push(
      `source_kind: review_request`,
      `review_request_event_id: ${trigger.source.id}`,
      `review_request_created_at: ${trigger.source.createdAt}`,
    );
  }
  if (trigger.source.kind === "subject_body") {
    lines.push(
      `source_kind: subject_body`,
      `subject_url: ${trigger.source.htmlUrl}`,
      `subject_updated_at: ${trigger.source.updatedAt}`,
    );
  }
  return lines.join("\n");
}

function formatGitHubPrompt(trigger: GitHubNotificationTrigger): string {
  if (trigger.kind === "review_requested") {
    return [
      "<review_request_guide>",
      "Sandi was requested as a reviewer on this GitHub pull request. Inspect the PR with GitHub runtime helpers before posting a conclusion. If there are actionable findings, use a pull request review when appropriate; otherwise leave a concise review comment.",
      "</review_request_guide>",
      "",
      `Pull request: ${trigger.thread.title}`,
      `URL: ${trigger.thread.htmlUrl}`,
    ].join("\n");
  }

  const body =
    trigger.source.kind === "review_request" ? "" : trigger.source.body.trim();
  const sourceLabel =
    trigger.source.kind === "review_comment"
      ? "review comment"
      : trigger.source.kind === "subject_body"
        ? `${trigger.thread.kind} body`
        : "issue comment";
  return [
    `<github_${sourceLabel.replaceAll(" ", "_")}>`,
    body || "Sandi was mentioned without additional comment text.",
    `</github_${sourceLabel.replaceAll(" ", "_")}>`,
  ].join("\n");
}

function accountRoutingProvenanceLines(input: {
  source: "github_mention" | "github_review_request";
  githubUserId: string;
  login: string;
  identityId: string | undefined;
}): string[] {
  return [
    "account_routing_policy: per-human ChatGPT/Codex account routing",
    `account_routing_source: ${input.source}`,
    `account_routing_github_user_id: ${input.githubUserId}`,
    `account_routing_identity_id: ${input.identityId ?? "unmapped_fail_closed"}`,
    `account_routing_username: ${input.login}`,
    `account_routing_display_name: ${input.login}`,
  ];
}

async function collectMentionTriggers(input: {
  api: GitHubNotificationApi;
  notification: GitHubNotification;
  botLogin: string;
  thread: GitHubThreadRef;
}): Promise<GitHubNotificationTrigger[]> {
  const latestCommentUrl = input.notification.subject.latest_comment_url;
  if (latestCommentUrl) {
    if (isIssueCommentUrl(latestCommentUrl)) {
      const comment = await input.api.getIssueCommentByUrl(latestCommentUrl);
      return triggerFromIssueComment({ ...input, comment });
    }
    if (isReviewCommentUrl(latestCommentUrl)) {
      const comment = await input.api.getReviewCommentByUrl(latestCommentUrl);
      return triggerFromReviewComment({ ...input, comment });
    }
  }

  const subject =
    input.thread.kind === "pull"
      ? await input.api.getPullRequest(input.thread)
      : await input.api.getIssue(input.thread);
  return triggerFromSubjectBody({ ...input, subject });
}

function triggerFromIssueComment(input: {
  notification: GitHubNotification;
  botLogin: string;
  thread: GitHubThreadRef;
  comment: IssueComment;
}): GitHubNotificationTrigger[] {
  if (isBotActor(input.comment.user, input.botLogin)) return [];
  if (!bodyMentionsLogin(input.comment.body, input.botLogin)) return [];
  return [
    {
      key: `github:mention:issue-comment:${input.comment.id}`,
      kind: "mention",
      notificationId: input.notification.id,
      notificationReason: input.notification.reason,
      notificationUpdatedAt: input.notification.updated_at,
      repository: input.notification.repository,
      thread: input.thread,
      actor: input.comment.user,
      source: {
        kind: "issue_comment",
        id: input.comment.id,
        htmlUrl: input.comment.html_url,
        createdAt: input.comment.created_at,
        updatedAt: input.comment.updated_at,
        body: input.comment.body ?? "",
      },
    },
  ];
}

function triggerFromReviewComment(input: {
  notification: GitHubNotification;
  botLogin: string;
  thread: GitHubThreadRef;
  comment: ReviewComment;
}): GitHubNotificationTrigger[] {
  if (isBotActor(input.comment.user, input.botLogin)) return [];
  if (!bodyMentionsLogin(input.comment.body, input.botLogin)) return [];
  const source: GitHubTriggerSource = {
    kind: "review_comment",
    id: input.comment.id,
    htmlUrl: input.comment.html_url,
    createdAt: input.comment.created_at,
    updatedAt: input.comment.updated_at,
    body: input.comment.body ?? "",
    path: input.comment.path,
    ...(input.comment.diff_hunk ? { diffHunk: input.comment.diff_hunk } : {}),
  };
  return [
    {
      key: `github:mention:review-comment:${input.comment.id}`,
      kind: "mention",
      notificationId: input.notification.id,
      notificationReason: input.notification.reason,
      notificationUpdatedAt: input.notification.updated_at,
      repository: input.notification.repository,
      thread: input.thread,
      actor: input.comment.user,
      source,
    },
  ];
}

function triggerFromSubjectBody(input: {
  notification: GitHubNotification;
  botLogin: string;
  thread: GitHubThreadRef;
  subject: Issue | PullRequest;
}): GitHubNotificationTrigger[] {
  if (isBotActor(input.subject.user, input.botLogin)) return [];
  if (!bodyMentionsLogin(input.subject.body, input.botLogin)) return [];
  return [
    {
      key: `github:mention:${input.thread.kind}:${input.thread.owner}/${input.thread.repo}:${input.thread.number}:${input.notification.updated_at}`,
      kind: "mention",
      notificationId: input.notification.id,
      notificationReason: input.notification.reason,
      notificationUpdatedAt: input.notification.updated_at,
      repository: input.notification.repository,
      thread: input.thread,
      actor: input.subject.user,
      source: {
        kind: "subject_body",
        htmlUrl: input.subject.html_url,
        updatedAt: input.notification.updated_at,
        body: input.subject.body ?? "",
      },
    },
  ];
}

async function collectReviewRequestTriggers(input: {
  api: GitHubNotificationApi;
  notification: GitHubNotification;
  botLogin: string;
  thread: GitHubThreadRef;
}): Promise<GitHubNotificationTrigger[]> {
  if (input.thread.kind !== "pull") return [];
  const pullRequest = await input.api.getPullRequest(input.thread);
  if (
    !pullRequest.requested_reviewers?.some((user) =>
      isBotActor(user, input.botLogin),
    )
  ) {
    return [];
  }
  const events = await input.api.listIssueEvents(input.thread);
  const latestEvent = events
    .filter((event) => isReviewRequestForBot(event, input.botLogin))
    .sort(compareIssueEventsDescending)[0];
  if (!latestEvent) return [];
  if (eventIsBeforeOrAt(latestEvent, input.notification.last_read_at))
    return [];
  return [reviewRequestTrigger({ ...input, event: latestEvent })];
}

function reviewRequestTrigger(input: {
  notification: GitHubNotification;
  thread: GitHubThreadRef;
  event: IssueEvent;
}): GitHubNotificationTrigger {
  const actor = input.event.actor ?? input.notification.repository.owner;
  return {
    key: `github:review-requested:${input.notification.repository.full_name}:${input.thread.number}:${input.event.id}`,
    kind: "review_requested",
    notificationId: input.notification.id,
    notificationReason: input.notification.reason,
    notificationUpdatedAt: input.notification.updated_at,
    repository: input.notification.repository,
    thread: input.thread,
    actor,
    source: {
      kind: "review_request",
      id: input.event.id,
      createdAt: input.event.created_at,
    },
  };
}

function isReviewRequestForBot(event: IssueEvent, botLogin: string): boolean {
  return (
    event.event === "review_requested" &&
    normalizeLogin(event.requested_reviewer?.login) === normalizeLogin(botLogin)
  );
}

function compareIssueEventsDescending(
  left: IssueEvent,
  right: IssueEvent,
): number {
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (Number.isFinite(byTime) && byTime !== 0) return byTime;
  return right.id - left.id;
}

function eventIsBeforeOrAt(
  event: IssueEvent,
  timestamp: string | null | undefined,
): boolean {
  if (!timestamp) return false;
  const eventMs = Date.parse(event.created_at);
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(eventMs) || !Number.isFinite(timestampMs)) return false;
  return eventMs <= timestampMs;
}

function threadFromNotification(
  notification: GitHubNotification,
): GitHubThreadRef | undefined {
  const kind = notificationSubjectKind(notification.subject.type);
  if (!kind) return undefined;
  const number = parseIssueNumberFromApiUrl(notification.subject.url, kind);
  if (number === undefined) return undefined;
  const repo = parseRepositoryFullName(notification.repository.full_name);
  return {
    ...repo,
    number,
    kind,
    title: notification.subject.title,
    htmlUrl: `${notification.repository.html_url}/${kind === "pull" ? "pull" : "issues"}/${number}`,
  };
}

function notificationSubjectKind(type: string): GitHubThreadKind | undefined {
  if (type === "PullRequest") return "pull";
  if (type === "Issue") return "issue";
  return undefined;
}

function parseIssueNumberFromApiUrl(
  url: string,
  kind: GitHubThreadKind,
): number | undefined {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  const collection = kind === "pull" ? "pulls" : "issues";
  const index = parts.indexOf(collection);
  if (index < 0) return undefined;
  const raw = parts[index + 1];
  if (!raw) return undefined;
  const number = Number.parseInt(raw, 10);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function isIssueCommentUrl(url: string): boolean {
  return new URL(url).pathname.includes("/issues/comments/");
}

function isReviewCommentUrl(url: string): boolean {
  return new URL(url).pathname.includes("/pulls/comments/");
}

function isBotActor(user: GitHubUser, botLogin: string): boolean {
  return normalizeLogin(user.login) === normalizeLogin(botLogin);
}

function normalizeLogin(login: string | undefined): string {
  return (login ?? "").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
