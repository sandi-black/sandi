import { join } from "node:path";

import type { HumanIdentityConfig } from "@/lib/identity/types";
import {
  consumePairing,
  normalizePairingCode,
} from "@/lib/pairing/pairing-store";
import { assertEqual, withTempDir } from "@/lib/verification/harness";
import { issueDeviceCode } from "@/surfaces/discord/bot/device-auth";

const IDENTITIES: HumanIdentityConfig = {
  version: 1,
  humans: [
    {
      id: "jess",
      displayName: "Jess",
      platforms: { discord: { id: "111", username: "jess" } },
    },
    {
      id: "legacy",
      displayName: "Legacy",
      platforms: { discord: { username: "legacy" } },
    },
  ],
};

async function verifyDeviceAuth(): Promise<void> {
  await verifyRecognizedUserIssuesRedeemableCode();
  await verifyUnknownOrIdlessUsersDeclined();
  console.log("device auth verification passed");
}

async function verifyRecognizedUserIssuesRedeemableCode(): Promise<void> {
  await withPairingsFile(async (path) => {
    const issued = await issueDeviceCode({
      identities: IDENTITIES,
      pairingsPath: path,
      discordUserId: "111",
    });
    if (!issued.ok) {
      console.error("expected a recognized id to be issued a code");
      process.exit(1);
    }
    assertEqual(issued.identityId, "jess", "issued code bound to the identity");

    // The displayed code, redeemed through the same store the API process reads,
    // resolves back to the same identity: proves it was written to the shared
    // pairings path and is valid end to end.
    const code = normalizePairingCode(issued.display);
    if (!code) {
      console.error("issued display code did not normalize");
      process.exit(1);
    }
    const consumed = await consumePairing({ path, code });
    assertEqual(
      consumed?.identityId,
      "jess",
      "issued code redeems to the identity",
    );
    console.log("ok a recognized Discord id is issued a redeemable code");
  });
}

async function verifyUnknownOrIdlessUsersDeclined(): Promise<void> {
  await withPairingsFile(async (path) => {
    const unknown = await issueDeviceCode({
      identities: IDENTITIES,
      pairingsPath: path,
      discordUserId: "999",
    });
    assertEqual(unknown.ok, false, "unknown Discord id is declined");

    // The username-only "legacy" record has no immutable id, so the strict
    // resolver never matches it and no code is issued.
    const idless = await issueDeviceCode({
      identities: IDENTITIES,
      pairingsPath: path,
      discordUserId: "legacy",
    });
    assertEqual(idless.ok, false, "id-less identity is declined");
    console.log("ok unknown and id-less users are declined without a code");
  });
}

async function withPairingsFile(
  run: (path: string) => Promise<void>,
): Promise<void> {
  await withTempDir("sandi-device-auth-", async (dir) => {
    await run(join(dir, "api-pairings.json"));
  });
}

await verifyDeviceAuth();
