import assert from "node:assert/strict";
import { join } from "node:path";

import {
  AmbiguousDeliveryError,
  DurableOutbox,
  PermanentDeliveryError,
} from "@/lib/delivery/outbox";
import { withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-outbox-", async (root) => {
  await verifyTransientAndAmbiguousRetry(join(root, "retry.json"));
  await verifyPermanentFailure(join(root, "permanent.json"));
  await verifyPartialProgress(join(root, "partial.json"));
  await verifyCrashRecovery(join(root, "crash.json"));
  await verifyConcurrentWorkers(join(root, "concurrent.json"));
  await verifyLongClaimRenewal(join(root, "renewal.json"));
});

async function verifyTransientAndAmbiguousRetry(path: string): Promise<void> {
  let now = Date.parse("2026-07-10T00:00:00.000Z");
  let attempts = 0;
  const outbox = testOutbox(path, () => now);
  outbox.register("message", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary outage");
    if (attempts === 2) {
      throw new AmbiguousDeliveryError("connection closed after request");
    }
    return { status: "complete", result: { remoteId: "message-1" } };
  });
  await outbox.enqueue({
    idempotencyKey: "message:ada",
    kind: "message",
    payload: { text: "hello", metadata: { grace: 1, ada: 2 } },
  });
  let record = await outbox.deliverNow("message:ada");
  assert.equal(record?.status, "pending");
  assert.equal(record?.attempts, 1);
  assert.equal(record?.lastError?.class, "transient");
  now += 10;
  record = await outbox.deliverNow("message:ada");
  assert.equal(record?.lastError?.class, "ambiguous");
  assert.deepEqual(record?.ambiguity, {
    policy: "retry-same-idempotency-key",
    count: 1,
  });
  now += 20;
  record = await outbox.deliverNow("message:ada");
  assert.equal(record?.status, "completed");
  assert.equal(record?.attempts, 3);
  assert.deepEqual(record?.result, { remoteId: "message-1" });
  assert.equal(
    record?.payload,
    null,
    "completed work releases its payload body",
  );
  assert.match(record?.payloadHash ?? "", /^[a-f0-9]{64}$/u);

  const duplicate = await outbox.enqueue({
    idempotencyKey: "message:ada",
    kind: "message",
    payload: { metadata: { ada: 2, grace: 1 }, text: "hello" },
  });
  assert.equal(duplicate.status, "completed");
  await assert.rejects(
    outbox.enqueue({
      idempotencyKey: "message:ada",
      kind: "message",
      payload: { text: "different" },
    }),
    /reused with different work/u,
  );
  console.log("ok outbox persists retry and ambiguous acknowledgement state");
}

async function verifyPermanentFailure(path: string): Promise<void> {
  const outbox = testOutbox(path, Date.now);
  outbox.register("message", async () => {
    throw new PermanentDeliveryError("target no longer exists");
  });
  await outbox.enqueue({
    idempotencyKey: "message:permanent",
    kind: "message",
    payload: null,
  });
  const record = await outbox.deliverNow("message:permanent");
  assert.equal(record?.status, "failed");
  assert.equal(record?.lastError?.class, "permanent");
  assert(record?.failedAt, "permanent failure records its terminal time");
  console.log("ok outbox records permanent delivery failure");
}

async function verifyPartialProgress(path: string): Promise<void> {
  let now = Date.parse("2026-07-10T00:30:00.000Z");
  const delivered: number[] = [];
  const outbox = testOutbox(path, () => now);
  outbox.register("chunks", async (record) => {
    const index = typeof record.progress === "number" ? record.progress : 0;
    if (index === 1) throw new Error("second chunk failed in first process");
    delivered.push(index);
    if (index < 2) return { status: "progress", progress: index + 1 };
    return { status: "complete" };
  });
  await outbox.enqueue({
    idempotencyKey: "chunks:grace",
    kind: "chunks",
    payload: ["a", "b", "c"],
  });
  let record = await outbox.deliverNow("chunks:grace");
  assert.equal(record?.status, "pending");
  assert.equal(record?.progress, 1);

  now += 20;
  const restarted = testOutbox(path, () => now);
  restarted.register("chunks", async (current) => {
    const index = typeof current.progress === "number" ? current.progress : 0;
    delivered.push(index);
    if (index < 2) return { status: "progress", progress: index + 1 };
    return { status: "complete" };
  });
  record = await restarted.deliverNow("chunks:grace");
  assert.equal(record?.status, "completed");
  assert.equal(record?.attempts, 4);
  assert.deepEqual(delivered, [0, 1, 2]);
  console.log(
    "ok outbox checkpoints and resumes multipart progress after restart",
  );
}

async function verifyCrashRecovery(path: string): Promise<void> {
  let now = Date.parse("2026-07-10T01:00:00.000Z");
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const crashed = testOutbox(path, () => now, 50);
  crashed.register("message", async () => {
    markStarted?.();
    return new Promise(() => {});
  });
  await crashed.enqueue({
    idempotencyKey: "message:crash",
    kind: "message",
    payload: { text: "recover me" },
  });
  void crashed.deliverNow("message:crash");
  await started;
  assert.equal((await crashed.get("message:crash"))?.status, "processing");
  crashed.stop();

  now += 51;
  const recovered = testOutbox(path, () => now, 50);
  recovered.register("message", async () => ({ status: "complete" }));
  const record = await recovered.deliverNow("message:crash");
  assert.equal(record?.status, "completed");
  assert.equal(record?.attempts, 2);
  console.log("ok outbox reclaims a crashed worker's expired delivery lease");
}

async function verifyConcurrentWorkers(path: string): Promise<void> {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = testOutbox(path, Date.now);
  const second = testOutbox(path, Date.now);
  const handler = async () => {
    calls += 1;
    await gate;
    return { status: "complete" as const };
  };
  first.register("message", handler);
  second.register("message", handler);
  await first.enqueue({
    idempotencyKey: "message:race",
    kind: "message",
    payload: { text: "once" },
  });
  const one = first.deliverNow("message:race");
  const two = second.deliverNow("message:race");
  for (let index = 0; calls === 0 && index < 100; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(calls, 1);
  release?.();
  await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal((await first.get("message:race"))?.status, "completed");
  console.log("ok outbox claim leases exclude concurrent workers");
}

async function verifyLongClaimRenewal(path: string): Promise<void> {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = {
    retryBaseMs: 10,
    retryMaxMs: 100,
    claimLeaseMs: 30,
    pollMaxMs: 100,
  };
  const first = new DurableOutbox(path, options);
  const second = new DurableOutbox(path, options);
  const handler = async () => {
    calls += 1;
    await gate;
    return { status: "complete" as const };
  };
  first.register("slow", handler);
  second.register("slow", handler);
  await first.enqueue({
    idempotencyKey: "slow:winlock",
    kind: "slow",
    payload: null,
  });
  const active = first.deliverNow("slow:winlock");
  for (let index = 0; calls === 0 && index < 100; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await second.deliverNow("slow:winlock");
  assert.equal(calls, 1, "a live worker renews before its claim can be stolen");
  release?.();
  await active;
  assert.equal((await first.get("slow:winlock"))?.status, "completed");
  console.log("ok outbox renews live claims during long deliveries");
}

function testOutbox(
  path: string,
  now: () => number,
  claimLeaseMs = 1_000,
): DurableOutbox {
  return new DurableOutbox(path, {
    now,
    retryBaseMs: 10,
    retryMaxMs: 100,
    claimLeaseMs,
    pollMaxMs: 100,
  });
}

console.log("delivery outbox verification passed");
