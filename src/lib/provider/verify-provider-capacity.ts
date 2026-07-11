import assert from "node:assert/strict";

import { loadCoreConfig } from "@/lib/config/env";
import {
  CapacityControlledProvider,
  ProviderCapacityError,
} from "@/lib/provider/capacity-controller";
import type {
  ModelProviderClient,
  ProviderProbe,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";

function verifyEnvironmentConfiguration(): void {
  const values = {
    SANDI_PROVIDER_MAX_CONCURRENT: "5",
    SANDI_PROVIDER_MAX_QUEUED: "17",
    SANDI_PROVIDER_MAX_QUEUED_PER_IDENTITY: "4",
    SANDI_PROVIDER_SHUTDOWN_GRACE_MS: "29",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    assert.deepEqual(loadCoreConfig().providerCapacity, {
      maxConcurrent: 5,
      maxQueued: 17,
      maxQueuedPerIdentity: 4,
      shutdownGraceMs: 29,
    });
    process.env["SANDI_PROVIDER_MAX_CONCURRENT"] = "0";
    assert.throws(
      () => loadCoreConfig(),
      /SANDI_PROVIDER_MAX_CONCURRENT must be a positive integer/u,
    );
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  console.log("ok provider capacity limits are configurable and validated");
}

async function verifyPriorityFairnessAndAdmission(): Promise<void> {
  const fake = new ManualProvider();
  const provider = new CapacityControlledProvider(fake, {
    maxConcurrent: 1,
    maxQueued: 8,
    maxQueuedPerIdentity: 2,
    shutdownGraceMs: 20,
  });
  const blocker = provider.generateTurn(request("blocker", "hopper"));
  await tick();

  const passive = provider.generateTurn(request("passive-gate:1", "hopper"));
  await rejects(
    provider.generateTurn(request("passive-gate:2", "hopper")),
    "passive_coalesced",
  );
  const firstQueued = provider.generateTurn(request("queued-1", "ada"));
  const secondQueued = provider.generateTurn(request("queued-2", "ada"));
  await rejects(
    provider.generateTurn(request("queued-3", "ada")),
    "identity_overloaded",
  );
  await rejects(
    provider.generateTurn(request("title:discard", "grace")),
    "title_discarded",
  );
  const canceledSignal = new AbortController();
  const canceled = provider.generateTurn({
    ...request("cancel-me", "grace"),
    signal: canceledSignal.signal,
  });
  canceledSignal.abort();
  await rejects(canceled, "aborted");

  fake.release("blocker");
  await blocker;
  await tick();
  assert.equal(
    fake.started[1],
    "queued-1",
    "interactive work jumps passive work",
  );
  fake.release("queued-1");
  await firstQueued;
  await tick();
  fake.release("queued-2");
  await secondQueued;
  await tick();
  fake.release("passive-gate:1");
  await passive;
  await provider.shutdown();

  const fairnessFake = new ManualProvider();
  const fair = new CapacityControlledProvider(fairnessFake, {
    maxConcurrent: 1,
    maxQueued: 16,
    maxQueuedPerIdentity: 16,
    shutdownGraceMs: 20,
  });
  const work = [fair.generateTurn(request("fair-blocker", "ada"))];
  await tick();
  work.push(fair.generateTurn(request("dream:background", "ada")));
  for (let index = 0; index < 5; index += 1) {
    work.push(fair.generateTurn(request(`interactive-${index}`, "ada")));
  }
  for (let index = 0; index < 7; index += 1) {
    const id = fairnessFake.started.at(-1);
    if (!id) throw new Error("fairness provider did not start work");
    fairnessFake.release(id);
    await tick();
  }
  await Promise.all(work);
  assert(
    fairnessFake.started.indexOf("dream:background") <= 4,
    "background work runs after at most four interactive starts",
  );
  await fair.shutdown();
  console.log(
    "ok capacity admission prioritizes interactive work without starvation",
  );
}

async function verifyCancellationAndShutdown(): Promise<void> {
  const fake = new ManualProvider();
  const provider = new CapacityControlledProvider(fake, {
    maxConcurrent: 1,
    maxQueued: 2,
    maxQueuedPerIdentity: 2,
    shutdownGraceMs: 5,
  });
  const active = provider.generateTurn(request("active-shutdown", "ada"));
  active.catch(() => undefined);
  await tick();
  const queued = provider.generateTurn(request("queued-shutdown", "ada"));
  const shutdown = provider.shutdown();
  await rejects(queued, "shutting_down");
  await shutdown;
  await assert.rejects(active, /aborted/u);
  await rejects(provider.generateTurn(request("late", "ada")), "shutting_down");
  assert.deepEqual(provider.status(), {
    active: 0,
    queued: 0,
    accepting: false,
  });
  console.log(
    "ok shutdown rejects queued work and aborts active work after grace",
  );
}

async function verifyAccountingRelease(): Promise<void> {
  let attempt = 0;
  const provider = new CapacityControlledProvider(
    providerFrom(async (request) => {
      attempt += 1;
      if (attempt === 1) throw new Error("provider failed");
      if (attempt === 2) throw new Error("provider timed out");
      return response(request.conversationId);
    }),
    {
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerIdentity: 1,
      shutdownGraceMs: 20,
    },
  );
  await assert.rejects(
    provider.generateTurn(request("failure", "hopper")),
    /provider failed/u,
  );
  await assert.rejects(
    provider.generateTurn(request("timeout", "hopper")),
    /provider timed out/u,
  );
  assert.equal(
    (await provider.generateTurn(request("recovered", "hopper"))).text,
    "recovered",
  );
  assert.deepEqual(provider.status(), {
    active: 0,
    queued: 0,
    accepting: true,
  });
  await provider.shutdown();
  console.log("ok error and timeout release provider capacity accounting");
}

async function verifyLoadDefaults(): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const provider = new CapacityControlledProvider(
    providerFrom(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return response(request.conversationId);
    }),
  );
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) =>
      provider.generateTurn(request(`load-${index}`, `identity-${index % 20}`)),
    ),
  );
  const accepted = results.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const rejected = results.length - accepted;
  assert.equal(
    accepted,
    67,
    "defaults admit active slots plus the bounded queue",
  );
  assert.equal(rejected, 33, "defaults explicitly reject excess burst work");
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    assert(result.reason instanceof ProviderCapacityError);
    assert.equal(result.reason.reason, "overloaded");
  }
  assert.equal(maxActive, 3, "default concurrency never exceeds three");
  await provider.shutdown();
  console.log(
    `provider capacity load evidence: burst=100 accepted=${accepted} rejected=${rejected} maxActive=${maxActive} queueLimit=64`,
  );
}

class ManualProvider implements ModelProviderClient {
  readonly started: string[] = [];
  readonly #pending = new Map<
    string,
    { resolve(value: ProviderTurnResponse): void; reject(error: Error): void }
  >();

  probe(): Promise<ProviderProbe> {
    return Promise.resolve(probe());
  }

  generateTurn(request: ProviderTurnRequest): Promise<ProviderTurnResponse> {
    this.started.push(request.conversationId);
    return new Promise((resolve, reject) => {
      this.#pending.set(request.conversationId, { resolve, reject });
      request.signal?.addEventListener(
        "abort",
        () => {
          this.#pending.delete(request.conversationId);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  release(conversationId: string): void {
    const pending = this.#pending.get(conversationId);
    if (!pending) throw new Error(`no pending provider turn ${conversationId}`);
    this.#pending.delete(conversationId);
    pending.resolve(response(conversationId));
  }
}

function providerFrom(
  generateTurn: (request: ProviderTurnRequest) => Promise<ProviderTurnResponse>,
): ModelProviderClient {
  return { probe: () => Promise.resolve(probe()), generateTurn };
}

function request(
  conversationId: string,
  identityId: string,
): ProviderTurnRequest {
  return {
    conversationId,
    instructions: "test",
    input: "test",
    accountRouting: { identityId },
    memoryContext: { memoryRoot: "memory", memoryScopes: [], participants: [] },
  };
}

function response(text: string): ProviderTurnResponse {
  return { text, deliverySideEffects: false, raw: {} };
}

function probe(): ProviderProbe {
  const result = { ok: true, detail: "test" };
  return { command: result, version: result, model: result };
}

async function rejects(
  promise: Promise<unknown>,
  reason: ProviderCapacityError["reason"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof ProviderCapacityError);
    assert.equal(error.reason, reason);
    return;
  }
  throw new Error(`expected provider capacity rejection ${reason}`);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

verifyEnvironmentConfiguration();
await verifyPriorityFairnessAndAdmission();
await verifyCancellationAndShutdown();
await verifyAccountingRelease();
await verifyLoadDefaults();

console.log("provider capacity verification passed");
