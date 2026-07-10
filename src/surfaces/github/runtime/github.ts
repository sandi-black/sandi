import { recordDeliverySideEffect } from "@/lib/provider/side-effects";
import { GitHubApi } from "@/surfaces/github/github/api";
import { GhCli } from "@/surfaces/github/github/gh-cli";
import {
  type GitHubContext,
  readGitHubPlatformContext,
} from "@/surfaces/github/runtime/context";
import {
  CommentInputSchema,
  CreatePullRequestReviewInputSchema,
  type GitHubRepoIssueTarget,
  ReplyToReviewCommentInputSchema,
  type RepoIssueFields,
  RepoIssueInputSchema,
  resolveRepoIssueTarget,
} from "@/surfaces/github/runtime/targets";

export type { GitHubContext } from "@/surfaces/github/runtime/context";

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
  return requireContext();
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
  const parsed = CommentInputSchema.parse(input);
  const created = await api().createIssueComment({
    ...resolveRepoIssueTarget(parsed, contextFallback()),
    body: parsed.body,
  });
  await recordDeliverySideEffect("github:comment");
  return created;
}

export async function replyToReviewComment(input: ReplyToReviewCommentInput) {
  const parsed = ReplyToReviewCommentInputSchema.parse(input);
  const commentId = parsed.commentId ?? currentReviewCommentId();
  if (commentId === undefined) {
    throw new Error(
      "replyToReviewComment needs commentId unless the current trigger is a review comment.",
    );
  }
  const created = await api().replyToReviewComment({
    ...resolveRepoIssueTarget(parsed, contextFallback()),
    commentId,
    body: parsed.body,
  });
  await recordDeliverySideEffect("github:review-comment-reply");
  return created;
}

export async function createPullRequestReview(
  input: CreatePullRequestReviewInput,
) {
  const parsed = CreatePullRequestReviewInputSchema.parse(input);
  const created = await api().createPullRequestReview({
    ...resolveRepoIssueTarget(parsed, contextFallback()),
    body: parsed.body,
    event: parsed.event ?? "COMMENT",
  });
  await recordDeliverySideEffect("github:pull-request-review");
  return created;
}

// The current GitHub thread context, when this turn originated on GitHub.
// Returns undefined on a turn from another surface (a desktop or Discord turn
// reaching into GitHub), where there is no current thread and every helper must
// name an explicit owner, repo, and number.
function optionalContext(): GitHubContext | undefined {
  return readGitHubPlatformContext();
}

// The current GitHub thread context, or an error. Used by helpers that only make
// sense on a GitHub-originated turn (reading the triggering thread, replying to
// the review comment that triggered the turn).
function requireContext(): GitHubContext {
  const context = optionalContext();
  if (!context) {
    throw new Error(
      "GitHub runtime helpers require SANDI_PLATFORM_CONTEXT from a GitHub turn.",
    );
  }
  return context;
}

function api(): GitHubApi {
  const command =
    process.env["SANDI_GH_COMMAND"]?.trim() ||
    process.env["GH_COMMAND"]?.trim() ||
    "gh";
  return new GitHubApi(new GhCli({ command }));
}

function resolveRepoIssue(input: RepoIssueInput): GitHubRepoIssueTarget {
  return resolveRepoIssueTarget(
    RepoIssueInputSchema.parse(input),
    contextFallback(),
  );
}

// The repo/issue fields the current GitHub thread can supply as a fallback, or
// undefined on a turn from another surface where every field must be explicit.
function contextFallback(): RepoIssueFields | undefined {
  const context = optionalContext();
  if (!context) return undefined;
  return {
    owner: context.repository.owner,
    repo: context.repository.repo,
    number: context.thread.number,
  };
}

function currentReviewCommentId(): number | undefined {
  const source = requireContext().trigger.source;
  if (source?.kind !== "review_comment") return undefined;
  return source.id;
}
