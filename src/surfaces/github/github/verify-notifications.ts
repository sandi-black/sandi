import { assert, assertEqual } from "@/lib/verification/harness";
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
import {
  bodyMentionsLogin,
  collectNotificationTriggers,
  type GitHubNotificationApi,
} from "@/surfaces/github/github/notifications";

const botLogin = "sandi-witch";
const enabledReasons = new Set(["mention", "review_requested"]);
const repo = repository();

assert(
  bodyMentionsLogin("@sandi-witch please look", botLogin),
  "direct mention",
);
assert(
  bodyMentionsLogin("cc @SANDI-WITCH, thoughts?", botLogin),
  "case-insensitive mention",
);
assert(!bodyMentionsLogin("@sandi-witchcraft no", botLogin), "word boundary");

const staleMentionApi = fakeNotificationApi({
  issueComment: issueComment("later comment without a mention"),
});
const staleMentionTriggers = await collectNotificationTriggers({
  api: staleMentionApi,
  notification: mentionNotification(),
  botLogin,
  enabledReasons,
});
assertEqual(staleMentionTriggers.length, 0, "stale mention should not trigger");

const mentionApi = fakeNotificationApi({
  issueComment: issueComment("hey @sandi-witch can you check this?"),
});
const mentionTriggers = await collectNotificationTriggers({
  api: mentionApi,
  notification: mentionNotification(),
  botLogin,
  enabledReasons,
});
assertEqual(mentionTriggers.length, 1, "direct mention trigger count");
assertEqual(
  mentionTriggers[0]?.key,
  "github:mention:issue-comment:9001",
  "direct mention trigger key",
);

const selfMentionApi = fakeNotificationApi({
  issueComment: issueComment(
    "@sandi-witch already replied",
    githubUser("sandi-witch", 282067348),
  ),
});
const selfMentionTriggers = await collectNotificationTriggers({
  api: selfMentionApi,
  notification: mentionNotification(),
  botLogin,
  enabledReasons,
});
assertEqual(selfMentionTriggers.length, 0, "self mention should not trigger");

const reviewRequestApi = fakeNotificationApi({
  pullRequest: pullRequest({
    requestedReviewers: [githubUser("sandi-witch", 282067348)],
  }),
  issueEvents: [
    {
      id: 7006,
      event: "review_requested",
      created_at: "2026-06-14T00:01:00Z",
      actor: githubUser("jess", 42),
      requested_reviewer: githubUser("sandi-witch", 282067348),
    },
    {
      id: 7007,
      event: "review_requested",
      created_at: "2026-06-14T00:03:00Z",
      actor: githubUser("jess", 42),
      requested_reviewer: githubUser("sandi-witch", 282067348),
    },
  ],
});
const reviewRequestTriggers = await collectNotificationTriggers({
  api: reviewRequestApi,
  notification: reviewRequestNotification(),
  botLogin,
  enabledReasons,
});
assertEqual(reviewRequestTriggers.length, 1, "review request trigger count");
assertEqual(
  reviewRequestTriggers[0]?.key,
  "github:review-requested:earendil-works/sandi:99:7007",
  "review request trigger key",
);

const staleReviewRequestApi = fakeNotificationApi({
  pullRequest: pullRequest({ requestedReviewers: [] }),
  issueEvents: [
    {
      id: 7008,
      event: "review_requested",
      created_at: "2026-06-14T00:03:00Z",
      actor: githubUser("jess", 42),
      requested_reviewer: githubUser("sandi-witch", 282067348),
    },
  ],
});
const staleReviewRequestTriggers = await collectNotificationTriggers({
  api: staleReviewRequestApi,
  notification: reviewRequestNotification(),
  botLogin,
  enabledReasons,
});
assertEqual(
  staleReviewRequestTriggers.length,
  0,
  "removed review request should not trigger",
);

const alreadyReadReviewRequestApi = fakeNotificationApi({
  pullRequest: pullRequest({
    requestedReviewers: [githubUser("sandi-witch", 282067348)],
  }),
  issueEvents: [
    {
      id: 7009,
      event: "review_requested",
      created_at: "2026-06-14T00:03:00Z",
      actor: githubUser("jess", 42),
      requested_reviewer: githubUser("sandi-witch", 282067348),
    },
  ],
});
const alreadyReadReviewRequestTriggers = await collectNotificationTriggers({
  api: alreadyReadReviewRequestApi,
  notification: {
    ...reviewRequestNotification(),
    last_read_at: "2026-06-14T00:04:00Z",
  },
  botLogin,
  enabledReasons,
});
assertEqual(
  alreadyReadReviewRequestTriggers.length,
  0,
  "already-read review request should not trigger",
);

console.log("GitHub notification routing verification passed");

function fakeNotificationApi(input: {
  issueComment?: IssueComment;
  reviewComment?: ReviewComment;
  pullRequest?: PullRequest;
  issueEvents?: IssueEvent[];
}): GitHubNotificationApi {
  return {
    async getIssueCommentByUrl(): Promise<IssueComment> {
      if (!input.issueComment) throw new Error("missing issue comment fixture");
      return input.issueComment;
    },
    async getReviewCommentByUrl(): Promise<ReviewComment> {
      if (!input.reviewComment) {
        throw new Error("missing review comment fixture");
      }
      return input.reviewComment;
    },
    async getPullRequest(): Promise<PullRequest> {
      return input.pullRequest ?? pullRequest();
    },
    async getIssue(): Promise<Issue> {
      return issue();
    },
    async listIssueEvents(): Promise<IssueEvent[]> {
      return input.issueEvents ?? [];
    },
  };
}

function mentionNotification(): GitHubNotification {
  return {
    id: "n1",
    unread: true,
    reason: "mention",
    updated_at: "2026-06-14T00:02:00Z",
    last_read_at: null,
    url: "https://api.github.com/notifications/threads/n1",
    repository: repo,
    subject: {
      title: "Mention Sandi",
      url: "https://api.github.com/repos/earendil-works/sandi/issues/12",
      latest_comment_url:
        "https://api.github.com/repos/earendil-works/sandi/issues/comments/9001",
      type: "Issue",
    },
  };
}

function reviewRequestNotification(): GitHubNotification {
  return {
    id: "n2",
    unread: true,
    reason: "review_requested",
    updated_at: "2026-06-14T00:04:00Z",
    last_read_at: null,
    url: "https://api.github.com/notifications/threads/n2",
    repository: repo,
    subject: {
      title: "Build GitHub surface",
      url: "https://api.github.com/repos/earendil-works/sandi/pulls/99",
      latest_comment_url: null,
      type: "PullRequest",
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
    created_at: "2026-06-14T00:01:00Z",
    updated_at: "2026-06-14T00:02:00Z",
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

function pullRequest(
  input: { requestedReviewers?: GitHubUser[] } = {},
): PullRequest {
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
    requested_reviewers: input.requestedReviewers ?? [
      githubUser("sandi-witch", 282067348),
    ],
    base: {
      ref: "main",
      sha: "base",
      repo,
    },
    head: {
      ref: "feature",
      sha: "head",
      repo,
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
