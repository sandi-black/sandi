import type {
  CanonicalConversationId,
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";

export type GitHubThreadKind = "issue" | "pull";

export type GitHubThreadRef = {
  owner: string;
  repo: string;
  number: number;
  kind: GitHubThreadKind;
  title: string;
  htmlUrl: string;
};

export function canonicalGitHubThreadId(
  input: Omit<GitHubThreadRef, "title" | "htmlUrl">,
): CanonicalConversationId {
  return `github:${input.owner}/${input.repo}:${input.kind}:${input.number}`;
}

export function githubConversationStorageId(
  input: Omit<GitHubThreadRef, "title" | "htmlUrl">,
): string {
  return [
    "github",
    safeStoragePart(input.owner),
    safeStoragePart(input.repo),
    input.kind,
    String(input.number),
  ].join("-");
}

export function buildGitHubThreadManifest(input: {
  thread: GitHubThreadRef;
  starter: ConversationParticipant;
}): ConversationManifest {
  const now = new Date().toISOString();
  return {
    canonicalId: canonicalGitHubThreadId(input.thread),
    surface: "github",
    platform: "github",
    kind: input.thread.kind,
    title: input.thread.title,
    createdAt: now,
    updatedAt: now,
    starterParticipantRef: participantRef(input.starter),
    participants: [input.starter],
    memoryScopes: githubThreadMemoryScopes(input.thread),
    surfacePrompt: githubThreadSurfacePrompt(input.thread),
    surfaceContext: {
      owner: input.thread.owner,
      repo: input.thread.repo,
      number: input.thread.number,
      kind: input.thread.kind,
      htmlUrl: input.thread.htmlUrl,
    },
  };
}

function githubThreadMemoryScopes(
  thread: Omit<GitHubThreadRef, "title" | "htmlUrl">,
): ConversationMemoryScope[] {
  return [
    {
      label:
        thread.kind === "pull"
          ? "Current GitHub Pull Request"
          : "Current GitHub Issue",
      refPrefix: `surfaces/github/repos/${thread.owner}/${thread.repo}/${thread.kind}s/${thread.number}`,
      area: "current_thread",
    },
    {
      label: "Current GitHub Repository",
      refPrefix: `surfaces/github/repos/${thread.owner}/${thread.repo}`,
      area: "current_repository",
    },
  ];
}

function githubThreadSurfacePrompt(thread: GitHubThreadRef): string {
  const noun = thread.kind === "pull" ? "pull request" : "issue";
  return [
    `This is a persistent GitHub ${noun} conversation.`,
    `Repository: ${thread.owner}/${thread.repo}`,
    `Thread: ${thread.htmlUrl}`,
    "Treat GitHub comments, review requests, and review-comment replies as the visible conversation on this thread.",
    "Use GitHub runtime helpers from code mode for explicit GitHub side effects such as posting multiple comments, replying to a review comment, or creating a pull request review.",
  ].join("\n");
}

function safeStoragePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}
