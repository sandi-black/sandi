import { join } from "node:path";

import { assert, withTempDir } from "@/lib/verification/harness";
import {
  type ClaimTriggerResult,
  GitHubNotificationState,
  type TriggerClaim,
} from "@/surfaces/github/github/state";

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
  const claimed = claims.filter((result) => typeof result === "object").length;
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
  const winningClaim = requireClaim(
    claims.find((result) => typeof result === "object"),
  );
  await state.releaseClaim(winningClaim);
  const replacement = await state.tryClaim(claimKey);
  assert(
    typeof replacement === "object",
    "a released claim must be re-claimable",
  );

  // Marking processed clears the claim and blocks further claims.
  await state.markProcessed(
    {
      key: claimKey,
      notificationId: `notification-${claimKey}`,
      reason: "mention",
      repository: "earendil-works/sandi",
      subject: `issue:${claimKey}`,
    },
    requireClaim(replacement),
  );
  assert(
    (await state.tryClaim(claimKey)) === "already-processed",
    "a processed claim key must report already-processed",
  );

  let now = Date.parse("2026-07-10T00:00:00.000Z");
  const owned = new GitHubNotificationState(join(dataDir, "owned"), () => now);
  const oldClaim = requireClaim(await owned.tryClaim("owned-key"));
  now += 31 * 60_000;
  const newClaim = requireClaim(await owned.tryClaim("owned-key"));
  assert(
    !(await owned.releaseClaim(oldClaim)),
    "an old worker cannot release a replacement claim",
  );
  assert(
    !(await owned.markProcessed(processedTrigger("owned-key"), oldClaim)),
    "an old worker cannot mark a replacement claim processed",
  );
  assert(
    (await owned.tryClaim("owned-key")) === "claimed-elsewhere",
    "the replacement claim survives stale-owner finalization",
  );
  now += 20 * 60_000;
  assert(
    await owned.renewClaim(newClaim),
    "the live owner can renew its claim",
  );
  now += 20 * 60_000;
  assert(
    (await owned.tryClaim("owned-key")) === "claimed-elsewhere",
    "a renewed long-running claim cannot be stolen",
  );

  console.log("GitHub notification state verification passed");
});

function requireClaim(result: ClaimTriggerResult | undefined): TriggerClaim {
  assert(typeof result === "object", "expected a successful claim result");
  return result.claim;
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
