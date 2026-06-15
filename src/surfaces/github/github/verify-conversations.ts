import type { ConversationParticipant } from "@/lib/conversations/types";
import {
  buildGitHubThreadManifest,
  canonicalGitHubThreadId,
  type GitHubThreadRef,
  githubConversationStorageId,
} from "@/surfaces/github/github/conversations";

const starter: ConversationParticipant = {
  platform: "github",
  platformUserId: "42",
  username: "jess",
  joinedAt: "2026-06-14T00:00:00.000Z",
};

const pullThread: GitHubThreadRef = {
  owner: "earendil-works",
  repo: "sandi",
  number: 123,
  kind: "pull",
  title: "Build GitHub surface",
  htmlUrl: "https://github.com/earendil-works/sandi/pull/123",
};

const issueThread: GitHubThreadRef = {
  owner: "earendil-works",
  repo: "sandi",
  number: 456,
  kind: "issue",
  title: "Mention Sandi",
  htmlUrl: "https://github.com/earendil-works/sandi/issues/456",
};

assertEqual(
  canonicalGitHubThreadId(pullThread),
  "github:earendil-works/sandi:pull:123",
  "canonical pull id",
);
assertEqual(
  canonicalGitHubThreadId(issueThread),
  "github:earendil-works/sandi:issue:456",
  "canonical issue id",
);
assertEqual(
  githubConversationStorageId(pullThread),
  "github-earendil-works-sandi-pull-123",
  "pull storage id",
);

const manifest = buildGitHubThreadManifest({
  thread: pullThread,
  starter,
});
assertEqual(manifest.surface, "github", "surface");
assertEqual(manifest.platform, "github", "platform");
assertEqual(manifest.kind, "pull", "kind");
assertEqual(
  manifest.memoryScopes[0]?.refPrefix,
  "surfaces/github/repos/earendil-works/sandi/pulls/123",
  "thread memory scope",
);
assertEqual(
  manifest.memoryScopes[1]?.refPrefix,
  "surfaces/github/repos/earendil-works/sandi",
  "repo memory scope",
);

console.log("GitHub conversation verification passed");

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  throw new Error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
