import assert from "node:assert/strict";
import { join } from "node:path";

import {
  createPairing,
  loadApiPairings,
  type PreparedPairingRedemption,
  redeemPairingTransaction,
} from "@/lib/pairing/pairing-store";
import { withTempDir } from "@/lib/verification/harness";

await verifyKnownWriteFailureRollsBack();
await verifyReservedCrashRecovery();
await verifyAmbiguousCommittedWriteCompletes();
await verifyConcurrentAndRepeatedRequestsAreIdempotent();

async function verifyKnownWriteFailureRollsBack(): Promise<void> {
  await withTransactionFile(async (path) => {
    const pairing = await createPairing({ path, identityId: "ada" });
    await assert.rejects(
      redeemPairingTransaction({
        path,
        code: pairing.code,
        authorize: async () => true,
        prepare: () => redemption("a", "ada-laptop"),
        persist: async () => {
          throw new Error("simulated token write failure");
        },
        isPersisted: async () => false,
      }),
      /simulated token write failure/u,
    );
    const afterFailure = await loadApiPairings(path);
    assert.equal(afterFailure.pairings[0]?.redemption, undefined);

    const retried = await redeemPairingTransaction({
      path,
      code: pairing.code,
      authorize: async () => true,
      prepare: () => redemption("b", "ada-laptop"),
      persist: async () => {},
      isPersisted: async () => false,
    });
    assert.equal(retried.kind, "success");
    if (retried.kind === "success") {
      assert.equal(retried.redemption.token, "b".repeat(64));
    }
  });
}

async function verifyReservedCrashRecovery(): Promise<void> {
  await withTransactionFile(async (path) => {
    const pairing = await createPairing({ path, identityId: "grace" });
    await assert.rejects(
      redeemPairingTransaction({
        path,
        code: pairing.code,
        authorize: async () => true,
        prepare: () => redemption("c", "grace-laptop"),
        persist: async () => {
          throw new Error("simulated crash after reservation");
        },
        isPersisted: async () => {
          throw new Error("token state unavailable");
        },
      }),
      /simulated crash after reservation/u,
    );
    const reserved = (await loadApiPairings(path)).pairings[0]?.redemption;
    assert.equal(reserved?.status, "reserved");

    const recovered = await redeemPairingTransaction({
      path,
      code: pairing.code,
      authorize: async () => true,
      prepare: () => {
        throw new Error("recovery must reuse the journaled token");
      },
      persist: async () => {},
      isPersisted: async () => false,
    });
    assert.equal(recovered.kind, "success");
    if (recovered.kind === "success") {
      assert.equal(recovered.redemption.token, "c".repeat(64));
    }
  });
}

async function verifyAmbiguousCommittedWriteCompletes(): Promise<void> {
  await withTransactionFile(async (path) => {
    const pairing = await createPairing({ path, identityId: "anna" });
    let persisted = false;
    const result = await redeemPairingTransaction({
      path,
      code: pairing.code,
      authorize: async () => true,
      prepare: () => redemption("d", "anna-laptop"),
      persist: async () => {
        persisted = true;
        throw new Error("simulated crash after token commit");
      },
      isPersisted: async () => persisted,
    });
    assert.equal(result.kind, "success");
    assert.equal(
      (await loadApiPairings(path)).pairings[0]?.redemption?.status,
      "completed",
    );
  });
}

async function verifyConcurrentAndRepeatedRequestsAreIdempotent(): Promise<void> {
  await withTransactionFile(async (path) => {
    const pairing = await createPairing({ path, identityId: "katherine" });
    let prepareCalls = 0;
    let persistCalls = 0;
    const run = () =>
      redeemPairingTransaction({
        path,
        code: pairing.code,
        authorize: async () => true,
        prepare: () => {
          prepareCalls += 1;
          return redemption("e", "katherine-laptop");
        },
        persist: async () => {
          persistCalls += 1;
        },
        isPersisted: async () => false,
      });
    const results = await Promise.all(Array.from({ length: 12 }, run));
    assert(results.every((result) => result.kind === "success"));
    assert.equal(prepareCalls, 1);
    assert.equal(persistCalls, 1);

    const replay = await redeemPairingTransaction({
      path,
      code: pairing.code,
      authorize: async () => true,
      prepare: () => {
        throw new Error("completed replay must not prepare another token");
      },
      persist: async () => {
        throw new Error("completed replay must not persist another token");
      },
      isPersisted: async () => false,
    });
    assert.equal(replay.kind, "success");
    if (replay.kind === "success") {
      assert.equal(replay.redemption.token, "e".repeat(64));
      assert.equal(replay.redemption.deviceId, "katherine-laptop");
    }
  });
}

function redemption(
  character: string,
  deviceId: string,
): PreparedPairingRedemption {
  const token = character.repeat(64);
  return {
    token,
    deviceId,
    label: `${deviceId} label`,
  };
}

async function withTransactionFile(
  run: (path: string) => Promise<void>,
): Promise<void> {
  await withTempDir("sandi-pairing-transaction-", async (dir) => {
    await run(join(dir, "api-pairings.json"));
  });
}

console.log("pairing transaction verification passed");
