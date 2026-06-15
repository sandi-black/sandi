import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubNotificationState } from "@/surfaces/github/github/state";

const dataDir = await mkdtemp(join(tmpdir(), "sandi-github-state-"));

try {
  const state = new GitHubNotificationState(dataDir);
  await Promise.all([
    state.markProcessed(processedTrigger("first")),
    state.markProcessed(processedTrigger("second")),
  ]);

  assert(await state.hasProcessed("first"), "first key should be retained");
  assert(await state.hasProcessed("second"), "second key should be retained");

  console.log("GitHub notification state verification passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function processedTrigger(key: string) {
  return {
    key,
    notificationId: `notification-${key}`,
    reason: "mention",
    repository: "earendil-works/sandi",
    subject: `issue:${key}`,
  };
}

function assert(value: boolean, label: string): void {
  if (value) return;
  throw new Error(label);
}
