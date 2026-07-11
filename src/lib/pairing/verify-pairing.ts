import { join } from "node:path";

import "@/lib/pairing/verify-pairing-transaction";
import {
  consumePairing,
  createPairing,
  generatePairingCode,
  loadApiPairings,
  normalizePairingCode,
} from "@/lib/pairing/pairing-store";
import { assertEqual, withTempDir } from "@/lib/verification/harness";

const IDENTITY_A = "alice";
const IDENTITY_B = "bob";

async function verifyPairing(): Promise<void> {
  await verifyNormalization();
  await verifyRoundTripSingleUse();
  await verifyExpiry();
  await verifySupersede();
  await verifyConcurrentRedeemConsumesOnce();
  console.log("pairing store verification passed");
}

function verifyNormalization(): void {
  const { code, display } = generatePairingCode();
  assertEqual(code.length, 10, "generated code length");
  assertEqual(display, `${code.slice(0, 5)}-${code.slice(5)}`, "display group");

  // A user may type the code lower-cased, with the grouping dash or spaces, and
  // may confuse the visually ambiguous letters. All of those normalize back to
  // the same canonical code.
  const grouped = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
  assertEqual(normalizePairingCode(grouped), code, "normalize grouped lower");
  assertEqual(
    normalizePairingCode(` ${code.slice(0, 5)} ${code.slice(5)} `),
    code,
    "normalize spaced",
  );
  assertEqual(
    normalizePairingCode("OIL1234567"),
    "0111234567",
    "fold ambiguous letters O, I, L",
  );

  assertEqual(
    normalizePairingCode("too-short"),
    undefined,
    "reject short code",
  );
  assertEqual(
    normalizePairingCode("ABCDE-FGHIJ-KLMNO"),
    undefined,
    "reject overlong code",
  );
  console.log("ok code generation and normalization round-trip");
}

async function verifyRoundTripSingleUse(): Promise<void> {
  await withPairingsFile(async (path) => {
    const pairing = await createPairing({ path, identityId: IDENTITY_A });
    const first = await consumePairing({ path, code: pairing.code });
    assertEqual(
      first?.identityId,
      IDENTITY_A,
      "first consume returns identity",
    );
    const second = await consumePairing({ path, code: pairing.code });
    assertEqual(second, undefined, "second consume is rejected (single use)");

    const file = await loadApiPairings(path);
    assertEqual(file.pairings.length, 0, "consumed code is removed from file");
    console.log("ok a code consumes exactly once and is then removed");
  });
}

async function verifyExpiry(): Promise<void> {
  await withPairingsFile(async (path) => {
    const issuedAt = 1_000_000;
    const pairing = await createPairing({
      path,
      identityId: IDENTITY_A,
      now: issuedAt,
      ttlMs: 60_000,
    });
    const afterExpiry = issuedAt + 60_000 + 1;
    const expired = await consumePairing({
      path,
      code: pairing.code,
      now: afterExpiry,
    });
    assertEqual(expired, undefined, "expired code is rejected");

    const file = await loadApiPairings(path);
    assertEqual(file.pairings.length, 0, "expired code is pruned");
    console.log("ok an expired code is rejected and pruned");
  });
}

async function verifySupersede(): Promise<void> {
  await withPairingsFile(async (path) => {
    const first = await createPairing({ path, identityId: IDENTITY_A });
    const second = await createPairing({ path, identityId: IDENTITY_A });
    // A second issue for the same identity supersedes the first.
    assertEqual(
      (await consumePairing({ path, code: first.code }))?.identityId,
      undefined,
      "superseded code no longer works",
    );
    assertEqual(
      (await consumePairing({ path, code: second.code }))?.identityId,
      IDENTITY_A,
      "latest code works",
    );

    // Issuing for one identity never disturbs another identity's live code.
    const aCode = await createPairing({ path, identityId: IDENTITY_A });
    await createPairing({ path, identityId: IDENTITY_B });
    assertEqual(
      (await consumePairing({ path, code: aCode.code }))?.identityId,
      IDENTITY_A,
      "other identity's code survives",
    );
    console.log("ok re-issuing supersedes only the same identity's code");
  });
}

async function verifyConcurrentRedeemConsumesOnce(): Promise<void> {
  await withPairingsFile(async (path) => {
    const pairing = await createPairing({ path, identityId: IDENTITY_A });
    // Fire many redemptions of the same code at once. The managed-write lock
    // must serialize them so exactly one wins and the rest see it gone.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumePairing({ path, code: pairing.code }),
      ),
    );
    const winners = results.filter(
      (result) => result?.identityId === IDENTITY_A,
    );
    assertEqual(winners.length, 1, "exactly one concurrent redeem wins");
    console.log("ok concurrent redemption consumes a code exactly once");
  });
}

async function withPairingsFile(
  run: (path: string) => Promise<void>,
): Promise<void> {
  await withTempDir("sandi-pairing-", async (dir) => {
    await run(join(dir, "api-pairings.json"));
  });
}

await verifyPairing();
