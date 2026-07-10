import { assert, withTempDir } from "@/lib/verification/harness";
import { GitHubNotificationState } from "@/surfaces/github/github/state";

await withTempDir("sandi-github-state-", async (dataDir) => {
  const state = new GitHubNotificationState(dataDir);
  await Promise.all([
    state.markProcessed(processedTrigger("first")),
    state.markProcessed(processedTrigger("second")),
  ]);

  assert(await state.hasProcessed("first"), "first key should be retained");
  assert(await state.hasProcessed("second"), "second key should be retained");

  // tryClaim must be atomic: concurrent claims on one key yield exactly one
  // "claimed" winner, the rest "claimed-elsewhere".
  const claimKey = "claim-race";
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => state.tryClaim(claimKey)),
  );
  const claimed = claims.filter((result) => result === "claimed").length;
  const elsewhere = claims.filter(
    (result) => result === "claimed-elsewhere",
  ).length;
  assert(claimed === 1, `expected exactly one claim winner, got ${claimed}`);
  assert(
    elsewhere === claims.length - 1,
    `expected all other claims to lose, got ${elsewhere}`,
  );

  // An already-processed trigger can never be claimed.
  assert(
    (await state.tryClaim("first")) === "already-processed",
    "a processed trigger must report already-processed",
  );

  // Releasing a claim makes the key claimable again.
  await state.releaseClaim(claimKey);
  assert(
    (await state.tryClaim(claimKey)) === "claimed",
    "a released claim must be re-claimable",
  );

  // Marking processed clears the claim and blocks further claims.
  await state.markProcessed({
    key: claimKey,
    notificationId: `notification-${claimKey}`,
    reason: "mention",
    repository: "earendil-works/sandi",
    subject: `issue:${claimKey}`,
  });
  assert(
    (await state.tryClaim(claimKey)) === "already-processed",
    "a processed claim key must report already-processed",
  );

  console.log("GitHub notification state verification passed");
});

function processedTrigger(key: string) {
  return {
    key,
    notificationId: `notification-${key}`,
    reason: "mention",
    repository: "earendil-works/sandi",
    subject: `issue:${key}`,
  };
}
