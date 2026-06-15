import { z } from "zod/v4";
import type { GhCli } from "@/surfaces/github/github/gh-cli";

export const GitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  html_url: z.string().optional(),
  type: z.string().optional(),
});

export const GitHubRepositorySchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  default_branch: z.string().optional(),
  owner: GitHubUserSchema.pick({
    id: true,
    login: true,
    html_url: true,
    type: true,
  }),
});

const NotificationSubjectSchema = z.object({
  title: z.string(),
  url: z.string(),
  latest_comment_url: z.string().nullable().optional(),
  type: z.string(),
});

export const GitHubNotificationSchema = z.object({
  id: z.string(),
  unread: z.boolean(),
  reason: z.string(),
  updated_at: z.string(),
  last_read_at: z.string().nullable().optional(),
  url: z.string(),
  repository: GitHubRepositorySchema,
  subject: NotificationSubjectSchema,
});

export const PullRequestSchema = z.object({
  number: z.number(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  diff_url: z.string().optional(),
  patch_url: z.string().optional(),
  draft: z.boolean().optional(),
  user: GitHubUserSchema,
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: GitHubRepositorySchema,
  }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: GitHubRepositorySchema.nullable(),
  }),
});

export const IssueSchema = z.object({
  number: z.number(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  user: GitHubUserSchema,
  pull_request: z.object({ url: z.string() }).optional(),
});

export const IssueCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  user: GitHubUserSchema,
});

export const ReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  user: GitHubUserSchema,
  path: z.string(),
  diff_hunk: z.string().optional(),
  commit_id: z.string().optional(),
  pull_request_url: z.string(),
  in_reply_to_id: z.number().nullable().optional(),
});

export const IssueEventSchema = z.object({
  id: z.number(),
  event: z.string(),
  created_at: z.string(),
  actor: GitHubUserSchema.nullable().optional(),
  requested_reviewer: GitHubUserSchema.nullable().optional(),
  requested_team: z
    .object({
      id: z.number().optional(),
      name: z.string().optional(),
      slug: z.string().optional(),
      html_url: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const PullRequestFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.string().optional(),
  blob_url: z.string().optional(),
  raw_url: z.string().optional(),
});

export type GitHubUser = z.infer<typeof GitHubUserSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export type GitHubNotification = z.infer<typeof GitHubNotificationSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type IssueComment = z.infer<typeof IssueCommentSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type IssueEvent = z.infer<typeof IssueEventSchema>;
export type PullRequestFile = z.infer<typeof PullRequestFileSchema>;

export class GitHubApi {
  readonly #gh: GhCli;

  constructor(gh: GhCli) {
    this.#gh = gh;
  }

  currentUser(): Promise<GitHubUser> {
    return this.#gh.apiJson({
      endpoint: "/user",
      schema: GitHubUserSchema,
    });
  }

  listNotifications(input: {
    participating: boolean;
    limit: number;
    all?: boolean;
  }): Promise<GitHubNotification[]> {
    const query = new URLSearchParams({
      participating: input.participating ? "true" : "false",
      per_page: String(input.limit),
    });
    if (input.all) query.set("all", "true");
    return this.#gh.apiJson({
      endpoint: `/notifications?${query.toString()}`,
      schema: z.array(GitHubNotificationSchema),
    });
  }

  getPullRequest(input: RepoIssueRef): Promise<PullRequest> {
    return this.#gh.apiJson({
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}`,
      schema: PullRequestSchema,
    });
  }

  getIssue(input: RepoIssueRef): Promise<Issue> {
    return this.#gh.apiJson({
      endpoint: `/repos/${repoPath(input)}/issues/${input.number}`,
      schema: IssueSchema,
    });
  }

  getIssueCommentByUrl(url: string): Promise<IssueComment> {
    return this.#gh.apiJson({
      endpoint: url,
      schema: IssueCommentSchema,
    });
  }

  getReviewCommentByUrl(url: string): Promise<ReviewComment> {
    return this.#gh.apiJson({
      endpoint: url,
      schema: ReviewCommentSchema,
    });
  }

  listIssueEvents(input: RepoIssueRef): Promise<IssueEvent[]> {
    return this.#gh.apiJsonPages({
      endpoint: `/repos/${repoPath(input)}/issues/${input.number}/events?per_page=100`,
      pageSchema: z.array(IssueEventSchema),
    });
  }

  listPullRequestFiles(input: RepoIssueRef): Promise<PullRequestFile[]> {
    return this.#gh.apiJsonPages({
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}/files?per_page=100`,
      pageSchema: z.array(PullRequestFileSchema),
    });
  }

  listIssueComments(input: RepoIssueRef): Promise<IssueComment[]> {
    return this.#gh.apiJsonPages({
      endpoint: `/repos/${repoPath(input)}/issues/${input.number}/comments?per_page=100`,
      pageSchema: z.array(IssueCommentSchema),
    });
  }

  listReviewComments(input: RepoIssueRef): Promise<ReviewComment[]> {
    return this.#gh.apiJsonPages({
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}/comments?per_page=100`,
      pageSchema: z.array(ReviewCommentSchema),
    });
  }

  getPullRequestDiff(input: RepoIssueRef): Promise<string> {
    return this.#gh.apiText({
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}`,
      accept: "application/vnd.github.v3.diff",
    });
  }

  createIssueComment(
    input: RepoIssueRef & { body: string },
  ): Promise<IssueComment> {
    return this.#gh.apiJson({
      method: "POST",
      endpoint: `/repos/${repoPath(input)}/issues/${input.number}/comments`,
      body: { body: input.body },
      schema: IssueCommentSchema,
    });
  }

  replyToReviewComment(
    input: RepoIssueRef & { commentId: number; body: string },
  ): Promise<ReviewComment> {
    return this.#gh.apiJson({
      method: "POST",
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}/comments/${input.commentId}/replies`,
      body: { body: input.body },
      schema: ReviewCommentSchema,
    });
  }

  createPullRequestReview(
    input: RepoIssueRef & {
      body: string;
      event?: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    },
  ): Promise<unknown> {
    return this.#gh.apiJson({
      method: "POST",
      endpoint: `/repos/${repoPath(input)}/pulls/${input.number}/reviews`,
      body: {
        body: input.body,
        event: input.event ?? "COMMENT",
      },
      schema: z.unknown(),
    });
  }
}

export type RepoRef = {
  owner: string;
  repo: string;
};

export type RepoIssueRef = RepoRef & {
  number: number;
};

export function repoPath(input: RepoRef): string {
  return `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
}

export function parseRepositoryFullName(fullName: string): RepoRef {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  return { owner, repo };
}
