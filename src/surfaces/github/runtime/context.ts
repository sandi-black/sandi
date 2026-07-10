import { z } from "zod/v4";
import {
  readPlatformContext,
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "@/lib/surface-context";

export const GITHUB_RUNTIME_IMPORT = "./sandi/runtime.ts";
// Every surface composes the unified runtime, so a GitHub turn can also reach
// Discord and the desktop helpers, not only GitHub's own.
export const GITHUB_RUNTIME_ENTRY = UNIFIED_RUNTIME_ENTRY;

export const GITHUB_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "github",
  skillsSurface: "github",
  runtimeImport: GITHUB_RUNTIME_IMPORT,
  runtimeEntry: GITHUB_RUNTIME_ENTRY,
};

// Lives here rather than in runtime/github.ts so readGitHubPlatformContext
// can parse against it directly: github.ts imports its platform context
// reader from this module, so defining the schema there instead would create
// an import cycle.
export const GitHubContextSchema = z.object({
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

export function readGitHubPlatformContext(): GitHubContext | undefined {
  return readPlatformContext("github", GitHubContextSchema);
}
