import assert from "node:assert/strict";
import "./verify-session-deletion";

import type { QueueState, TurnSettledEvent } from "@shared/ipc-contract";

import { createTurnManager, type SendTurnFn } from "./turn-manager";

// Exercises the client-side turn queue with a fake sendTurn: FIFO order,
// instant queue-state events, stop cancelling only the in-flight turn,
// cancellation of queued turns, and cross-conversation independence.
// Run with: npm run verify:turn-manager-queue -w app

type Pending = {
  turnId: string;
  conversationId: string;
  signal: AbortSignal;
  resolve(text: string): void;
};

function main(): void {
  const synchronousFailures: TurnSettledEvent[] = [];
  const synchronousThrowManager = createTurnManager({
    sendTurn: () => {
      throw new Error("transport setup failed");
    },
    events: {
      onTurnStarted: () => undefined,
      onTurnSettled: (event) => {
        synchronousFailures.push(event);
      },
      onQueueState: () => undefined,
    },
  });
  synchronousThrowManager.submit({
    conversationId: "sync-failure",
    text: "hello",
    turnId: "sync-t1",
    attachmentIds: [],
  });
  assert.equal(
    synchronousFailures[0]?.error,
    "transport setup failed",
    "a synchronous transport failure settles instead of wedging the queue",
  );
  assert.deepEqual(
    synchronousThrowManager.queueState("sync-failure").pending,
    [],
    "the failed conversation queue is released",
  );
  assert.equal(
    synchronousThrowManager.isIdle(),
    true,
    "Sandi is idle after the failed turn settles",
  );

  const inFlight: Pending[] = [];
  const started: string[] = [];
  const settled: TurnSettledEvent[] = [];
  const queueStates: QueueState[] = [];

  const sendTurn: SendTurnFn = ({ conversationId, turnId, signal }) =>
    new Promise((resolve) => {
      const finish = (text: string): void =>
        resolve({ ok: true, conversationId, text });
      inFlight.push({ turnId, conversationId, signal, resolve: finish });
      signal.addEventListener("abort", () =>
        resolve({ ok: false, error: "aborted by signal" }),
      );
    });

  const manager = createTurnManager({
    sendTurn,
    events: {
      onTurnStarted: (event) => started.push(event.turnId),
      onTurnSettled: (event) => {
        settled.push(event);
      },
      onQueueState: (state) => queueStates.push(state),
    },
  });

  // Three rapid submits to one conversation: the first starts immediately,
  // the rest queue in order.
  manager.submit({
    conversationId: "c1",
    text: "one",
    turnId: "t1",
    attachmentIds: [],
  });
  manager.submit({
    conversationId: "c1",
    text: "two",
    turnId: "t2",
    attachmentIds: [],
  });
  manager.submit({
    conversationId: "c1",
    text: "three",
    turnId: "t3",
    attachmentIds: [],
  });
  assert.deepEqual(started, ["t1"], "only the first turn is in flight");
  assert.equal(manager.isIdle(), false, "queued or running turns are work");
  assert.equal(inFlight.length, 1, "one socket per conversation");
  const state = manager.queueState("c1");
  assert.equal(state.inflightTurnId, "t1");
  assert.deepEqual(
    state.pending.map((turn) => turn.turnId),
    ["t2", "t3"],
    "the rest wait as chips",
  );

  // A second conversation runs in parallel, unaffected by c1's queue.
  manager.submit({
    conversationId: "c2",
    text: "hi",
    turnId: "u1",
    attachmentIds: [],
  });
  assert.deepEqual(started, ["t1", "u1"], "conversations are independent");

  // Cancelling a queued turn removes it without touching the in-flight one.
  manager.cancelQueued("t2");
  assert.deepEqual(
    manager.queueState("c1").pending.map((turn) => turn.turnId),
    ["t3"],
    "t2 left the queue",
  );

  // Stop aborts only the in-flight turn; the queued turn then drains.
  manager.stop("t1");
  queueMicrotask(() => {
    assert.equal(settled[0]?.turnId, "t1");
    assert.equal(settled[0]?.ok, false, "stopped turn settles as failure");
    assert.equal(settled[0]?.error, "stopped", "abort maps to a stop");
    assert.deepEqual(started, ["t1", "u1", "t3"], "t3 drained after the stop");

    // t3 completes normally.
    const t3 = inFlight.find((turn) => turn.turnId === "t3");
    assert.ok(t3, "t3 is in flight");
    t3.resolve("the answer");
    queueMicrotask(() => {
      const done = settled.find((event) => event.turnId === "t3");
      assert.ok(done?.ok, "t3 settles ok");
      assert.equal(done.text, "the answer");
      assert.equal(
        manager.queueState("c1").inflightTurnId,
        undefined,
        "c1 queue is empty again",
      );
      assert.equal(
        manager.isIdle(),
        false,
        "the other conversation still keeps Sandi busy",
      );
      // Queue-state events fired for every transition (submit, start, stop,
      // drain); the exact count matters less than that the final state is
      // consistent and events kept flowing.
      assert.ok(queueStates.length >= 6, "queue state events flowed");
      console.log("verify-turn-manager-queue: ok");
    });
  });
}

main();
