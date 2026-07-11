import assert from "node:assert/strict";

import { deleteSessionIfIdle } from "./session-deletion";
import { createTurnManager } from "./turn-manager";
import type { TurnOutcome } from "@sandi-server/surfaces/api/client/turns";

const turn = deferred<TurnOutcome>();
const persistence = deferred<void>();
const deleted: string[] = [];
let changes = 0;

const manager = createTurnManager({
  sendTurn: () => turn.promise,
  events: {
    onTurnStarted: () => undefined,
    // A settled network request is still active work until its transcript is
    // durable; deleting in this interval was the orphan-recreation race.
    onTurnSettled: () => persistence.promise,
    onQueueState: () => undefined,
  },
});

manager.submit({
  conversationId: "ada-session",
  text: "Analyze the engine",
  turnId: "active-turn",
  attachmentIds: [],
});
manager.submit({
  conversationId: "ada-session",
  text: "Write the notes",
  turnId: "queued-turn",
  attachmentIds: [],
});
assert.equal(manager.hasWork("ada-session"), true);
assert.deepEqual(await attemptDelete(), { ok: false, reason: "busy" });
assert.deepEqual(deleted, []);

manager.cancelQueued("queued-turn");
assert.equal(manager.hasWork("ada-session"), true);

turn.resolve({
  ok: true,
  conversationId: "ada-session",
  text: "Analysis complete",
});
await Promise.resolve();
await Promise.resolve();
assert.equal(
  manager.hasWork("ada-session"),
  true,
  "settlement persistence remains active work",
);
assert.deepEqual(await attemptDelete(), { ok: false, reason: "busy" });

persistence.resolve();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(manager.hasWork("ada-session"), false);
assert.deepEqual(await attemptDelete(), { ok: true });
assert.deepEqual(deleted, ["ada-session"]);
assert.equal(changes, 1);

function attemptDelete() {
  return deleteSessionIfIdle({
    conversationId: "ada-session",
    hasWork: (conversationId) => manager.hasWork(conversationId),
    deleteSession: async (conversationId) => {
      deleted.push(conversationId);
    },
    onDeleted: () => {
      changes += 1;
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve = (_value: T): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

console.log("verify-session-deletion: ok");
