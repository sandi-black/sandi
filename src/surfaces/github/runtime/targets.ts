import { z } from "zod/v4";

// Boundary schemas for the GitHub action inputs that runtime helpers accept from
// sandi_js_run code. The values are constructed by generated code before they
// flow into gh / the GitHub API, so parsing them into precise shapes here turns a
// blank owner or a non-positive number into a clear error at the helper boundary
// instead of an opaque API failure.

export const GitHubOwnerSchema = z
  .string()
  .trim()
  .min(1, "owner must not be empty");
export const GitHubRepoNameSchema = z
  .string()
  .trim()
  .min(1, "repo must not be empty");
export const GitHubNumberSchema = z
  .number()
  .int("number must be an integer")
  .positive("number must be positive");
export const GitHubBodySchema = z.string().min(1, "body must not be empty");
export const GitHubReviewEventSchema = z.enum([
  "APPROVE",
  "COMMENT",
  "REQUEST_CHANGES",
]);

export const RepoIssueInputSchema = z.object({
  owner: GitHubOwnerSchema.optional(),
  repo: GitHubRepoNameSchema.optional(),
  number: GitHubNumberSchema.optional(),
});

export const GitHubRepoIssueTargetSchema = z.object({
  owner: GitHubOwnerSchema,
  repo: GitHubRepoNameSchema,
  number: GitHubNumberSchema,
});
export type GitHubRepoIssueTarget = z.infer<typeof GitHubRepoIssueTargetSchema>;

export const CommentInputSchema = RepoIssueInputSchema.extend({
  body: GitHubBodySchema,
});

export const ReplyToReviewCommentInputSchema = RepoIssueInputSchema.extend({
  commentId: GitHubNumberSchema.optional(),
  body: GitHubBodySchema,
});

export const CreatePullRequestReviewInputSchema = RepoIssueInputSchema.extend({
  body: GitHubBodySchema,
  event: GitHubReviewEventSchema.optional(),
});

// A repo/issue target carried by an already-parsed helper input. The action
// schemas above all extend RepoIssueInputSchema, so this is the parsed shape
// every caller threads in without re-parsing the boundary.
export type RepoIssueFields = {
  owner?: string | undefined;
  repo?: string | undefined;
  number?: number | undefined;
};

// Resolves an already-parsed owner/repo/number against the current thread's
// fallback (the GitHub context's repository and thread number, when this turn
// originated on GitHub), then validates the resolved target. The input is parsed
// once by the caller's schema; only the resolved target (which may draw on
// context values) is validated here. Throws a clear error when a turn from
// another surface omits a field the context cannot supply.
export function resolveRepoIssueTarget(
  input: RepoIssueFields,
  fallback: RepoIssueFields | undefined,
): GitHubRepoIssueTarget {
  const owner = input.owner ?? fallback?.owner;
  const repo = input.repo ?? fallback?.repo;
  const number = input.number ?? fallback?.number;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(
      "Provide owner, repo, and number to target a GitHub thread from a turn that did not originate on GitHub.",
    );
  }
  return GitHubRepoIssueTargetSchema.parse({ owner, repo, number });
}
