import { z } from "zod/v4";
import { recordDeliverySideEffect } from "@/lib/provider/side-effects";
import { GitHubApi } from "@/surfaces/github/github/api";
import { GhCli } from "@/surfaces/github/github/gh-cli";
import { readGitHubPlatformContext } from "@/surfaces/github/runtime/context";

const GitHubContextSchema = z.object({
  platform: z.literal("github"),
  bot: z.object({
    id: z.number(),
    login: z.string(),
    htmlUrl: z.string().optional(),
  }),
  repository: z.object({
    owner: z.string(),
    repo: z.string(),
    fullName: z.string(),
    htmlUrl: z.string(),
    defaultBranch: z.string().optional(),
  }),
  thread: z.object({
    kind: z.enum(["issue", "pull"]),
    number: z.number(),
    title: z.string(),
    htmlUrl: z.string(),
  }),
  trigger: z.object({
    key: z.string(),
    kind: z.enum(["mention", "review_requested"]),
    notificationId: z.string(),
    notificationReason: z.string(),
    notificationUpdatedAt: z.string(),
    source: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("issue_comment"),
          id: z.number(),
          htmlUrl: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
          body: z.string(),
        }),
        z.object({
          kind: z.literal("review_comment"),
          id: z.number(),
          htmlUrl: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
          body: z.string(),
          path: z.string(),
          diffHunk: z.string().optional(),
        }),
        z.object({
          kind: z.literal("review_request"),
          id: z.number(),
          createdAt: z.string(),
        }),
        z.object({
          kind: z.literal("subject_body"),
          htmlUrl: z.string(),
          updatedAt: z.string(),
          body: z.string(),
        }),
      ])
      .optional(),
    actor: z.object({
      id: z.number(),
      login: z.string(),
      htmlUrl: z.string().optional(),
    }),
  }),
});

export type GitHubContext = z.infer<typeof GitHubContextSchema>;

export type RepoIssueInput = {
  owner?: string;
  repo?: string;
  number?: number;
};

export type CommentInput = RepoIssueInput & {
  body: string;
};

export type ReplyToReviewCommentInput = RepoIssueInput & {
  commentId?: number;
  body: string;
};

export type CreatePullRequestReviewInput = RepoIssueInput & {
  body: string;
  event?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
};

export function currentContext(): GitHubContext {
  return readContext();
}

export async function getPullRequest(input: RepoIssueInput = {}) {
  return api().getPullRequest(resolveRepoIssue(input));
}

export async function getIssue(input: RepoIssueInput = {}) {
  return api().getIssue(resolveRepoIssue(input));
}

export async function listPullRequestFiles(input: RepoIssueInput = {}) {
  return api().listPullRequestFiles(resolveRepoIssue(input));
}

export async function listIssueComments(input: RepoIssueInput = {}) {
  return api().listIssueComments(resolveRepoIssue(input));
}

export async function listReviewComments(input: RepoIssueInput = {}) {
  return api().listReviewComments(resolveRepoIssue(input));
}

export async function getPullRequestDiff(
  input: RepoIssueInput = {},
): Promise<string> {
  return api().getPullRequestDiff(resolveRepoIssue(input));
}

export async function comment(input: CommentInput) {
  const created = await api().createIssueComment({
    ...resolveRepoIssue(input),
    body: input.body,
  });
  await recordDeliverySideEffect("github:comment");
  return created;
}

export async function replyToReviewComment(input: ReplyToReviewCommentInput) {
  const commentId = input.commentId ?? currentReviewCommentId();
  if (commentId === undefined) {
    throw new Error(
      "replyToReviewComment needs commentId unless the current trigger is a review comment.",
    );
  }
  const created = await api().replyToReviewComment({
    ...resolveRepoIssue(input),
    commentId,
    body: input.body,
  });
  await recordDeliverySideEffect("github:review-comment-reply");
  return created;
}

export async function createPullRequestReview(
  input: CreatePullRequestReviewInput,
) {
  const created = await api().createPullRequestReview({
    ...resolveRepoIssue(input),
    body: input.body,
    event: input.event ?? "COMMENT",
  });
  await recordDeliverySideEffect("github:pull-request-review");
  return created;
}

function readContext(): GitHubContext {
  const raw = readGitHubPlatformContext();
  if (!raw) {
    throw new Error(
      "GitHub runtime helpers require SANDI_PLATFORM_CONTEXT from a GitHub turn.",
    );
  }
  return GitHubContextSchema.parse(JSON.parse(raw));
}

function api(): GitHubApi {
  const command =
    process.env["SANDI_GH_COMMAND"]?.trim() ||
    process.env["GH_COMMAND"]?.trim() ||
    "gh";
  return new GitHubApi(new GhCli({ command }));
}

function resolveRepoIssue(input: RepoIssueInput) {
  const context = readContext();
  return {
    owner: input.owner ?? context.repository.owner,
    repo: input.repo ?? context.repository.repo,
    number: input.number ?? context.thread.number,
  };
}

function currentReviewCommentId(): number | undefined {
  const source = readContext().trigger.source;
  if (source?.kind !== "review_comment") return undefined;
  return source.id;
}
