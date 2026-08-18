import assert from "node:assert/strict";
import { join } from "node:path";

import { TurnJournal, turnJournalPath } from "@/lib/turns/turn-journal";
import { withTempDir } from "@/lib/verification/harness";

// The payload is opaque to the journal: a surface stores whatever it needs to
// find the work again, so these fixtures deliberately carry no surface shape.

assert.equal(
  turnJournalPath("/srv/sandi/data"),
  join("/srv/sandi/data", "state", "turn-journal.json"),
);

// The everyday path: a turn is owed from the moment it is accepted until it
// settles, and a settled turn is never replayed.
await withTempDir("sandi-turn-journal-", async (root) => {
  const now = Date.parse("2026-08-18T20:41:06.000Z");
  const journal = new TurnJournal(join(root, "journal.json"), {
    now: () => now,
  });

  await journal.accept("turn:ada", {
    source: "source-1",
    turnRef: "ada",
  });
  const pending = await journal.pending();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.payload, {
    source: "source-1",
    turnRef: "ada",
  });
  assert.equal(pending[0]?.attempts, 0);

  await journal.settle("turn:ada");
  assert.deepEqual(await journal.pending(), []);
  assert.deepEqual(await journal.claimReplayable(), []);

  // Settling a key that already left the journal is how a replayed turn that
  // finishes normally behaves, so it must not throw.
  await journal.settle("turn:ada");
});

// A restart replays what was owed, and the attempt is charged up front so a
// turn that takes the process down with it cannot be retried forever.
await withTempDir("sandi-turn-journal-attempts-", async (root) => {
  const now = Date.parse("2026-08-18T20:41:06.000Z");
  const path = join(root, "journal.json");
  const options = { now: () => now, maxAttempts: 2 };
  const journal = new TurnJournal(path, options);

  await journal.accept("turn:grace", {
    source: "source-1",
    turnRef: "grace",
  });

  const first = await journal.claimReplayable();
  assert.equal(first.length, 1, "an unsettled turn is replayed");
  assert.equal(first[0]?.attempts, 1, "the attempt is charged before replay");
  assert.equal(
    (await journal.pending()).length,
    1,
    "the entry survives the claim so a crash mid-replay keeps it",
  );

  // Re-accepting during replay must not hand the turn a fresh budget.
  await journal.accept("turn:grace", {
    source: "source-1",
    turnRef: "grace",
  });
  assert.equal((await journal.pending())[0]?.attempts, 1);

  const second = await journal.claimReplayable();
  assert.equal(second[0]?.attempts, 2);

  assert.deepEqual(
    await journal.claimReplayable(),
    [],
    "the turn is abandoned once it exhausts its attempts",
  );
  assert.deepEqual(await journal.pending(), []);
});

// Coming back from a long outage must not flood a channel with answers to
// messages nobody is waiting on any more.
await withTempDir("sandi-turn-journal-window-", async (root) => {
  let now = Date.parse("2026-08-18T20:41:06.000Z");
  const journal = new TurnJournal(join(root, "journal.json"), {
    now: () => now,
    maxAgeMs: 15 * 60_000,
  });

  await journal.accept("turn:fresh", {
    source: "source-1",
    turnRef: "fresh",
  });
  now += 14 * 60_000;
  await journal.accept("turn:stale", {
    source: "source-1",
    turnRef: "stale",
  });

  // "fresh" is now 14 minutes old and "stale" was accepted a moment ago, so a
  // restart one minute later keeps both.
  now += 60_000;
  const withinWindow = await journal.claimReplayable();
  assert.deepEqual(withinWindow.map((entry) => entry.key).sort(), [
    "turn:fresh",
    "turn:stale",
  ]);

  // Another two minutes puts "fresh" past the window while "stale" survives.
  now += 2 * 60_000;
  const aged = await journal.claimReplayable();
  assert.deepEqual(
    aged.map((entry) => entry.key),
    ["turn:stale"],
  );
  assert.deepEqual(
    (await journal.pending()).map((entry) => entry.key),
    ["turn:stale"],
    "the turn that aged out is forgotten rather than retried later",
  );
});

// The journal is the durable half of the queue, so a fresh instance over the
// same file has to see what the last process was still owed.
await withTempDir("sandi-turn-journal-restart-", async (root) => {
  const path = join(root, "journal.json");
  const now = Date.parse("2026-08-18T20:41:06.000Z");
  const before = new TurnJournal(path, { now: () => now });
  await before.accept("turn:anna", {
    source: "source-1",
    turnRef: "anna",
  });

  const after = new TurnJournal(path, { now: () => now + 30_000 });
  const owed = await after.claimReplayable();
  assert.deepEqual(
    owed.map((entry) => entry.payload),
    [{ source: "source-1", turnRef: "anna" }],
  );
});

console.log("Turn journal verification passed");
