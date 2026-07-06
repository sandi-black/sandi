import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import type { PetDisplayEvent } from "@shared/ipc-contract";
import type { PetOneShot } from "@shared/pet-state-machine";

import {
  createIdleFidgetScheduler,
  type IdleFidgetHost,
  type IdleFidgetOptions,
} from "./idle-fidget-scheduler";

// Exercises the idle-fidget scheduler against a fake host at millisecond scale:
// it fires one-shots from its pool while the gate is open, rearms itself, holds
// off entirely when gated, reports its busy window, and goes quiet on disable.
// Run with: npm run verify:idle-fidget-scheduler -w app

type FakeHost = IdleFidgetHost & {
  fidgetable: boolean;
  events: PetDisplayEvent[];
};

function createFakeHost(): FakeHost {
  const host: FakeHost = {
    fidgetable: true,
    events: [],
    canFidget: () => host.fidgetable,
    sendDisplayEvent: (event) => host.events.push(event),
  };
  return host;
}

function oneShotRows(host: FakeHost): PetOneShot[] {
  return host.events
    .filter((event) => event.type === "one-shot")
    .map((event) => event.row);
}

// Fast, deterministic config: no pause, a short busy window, and a single-row
// pool so every fire is predictable.
const FAST: IdleFidgetOptions = {
  pauseRangeMs: [0, 0],
  durationMs: () => 5,
  pool: ["blink"],
  random: () => 0,
};

async function testFiresAndRearms(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createIdleFidgetScheduler(host, FAST);
  scheduler.setEnabled(true);
  await sleep(60);
  scheduler.dispose();
  const rows = oneShotRows(host);
  assert.ok(rows.length >= 2, "an idle pet fidgets and rearms itself");
  assert.ok(
    rows.every((row) => row === "blink"),
    "every fidget is drawn from the pool",
  );
}

async function testPicksFromPool(): Promise<void> {
  const host = createFakeHost();
  // random 0.1 over a two-row pool selects index 0 ("waving"); the same value
  // yields a zero-length pause, so the pick is the only meaningful draw.
  const scheduler = createIdleFidgetScheduler(host, {
    ...FAST,
    durationMs: () => 100,
    pool: ["waving", "blink"],
    random: () => 0.1,
  });
  scheduler.setEnabled(true);
  await sleep(20);
  scheduler.dispose();
  const rows = oneShotRows(host);
  assert.ok(rows.length > 0, "a fidget fired");
  assert.equal(rows[0], "waving", "the pick follows the injected random");
}

async function testAvoidsImmediateRepeatWhenPossible(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createIdleFidgetScheduler(host, {
    pauseRangeMs: [0, 0],
    durationMs: () => 5,
    pool: ["blink", "waving"],
    random: () => 0,
  });
  scheduler.setEnabled(true);
  await sleep(30);
  scheduler.dispose();
  const rows = oneShotRows(host);
  assert.ok(rows.length >= 2, "multiple fidgets fired");
  assert.notEqual(
    rows[0],
    rows[1],
    "the scheduler avoids repeating the same fidget when another exists",
  );
}

async function testGateBlocks(): Promise<void> {
  const host = createFakeHost();
  host.fidgetable = false;
  const scheduler = createIdleFidgetScheduler(host, FAST);
  scheduler.setEnabled(true);
  await sleep(30);
  scheduler.dispose();
  assert.equal(host.events.length, 0, "a gated pet never fidgets");
}

async function testGateReopens(): Promise<void> {
  const host = createFakeHost();
  host.fidgetable = false;
  const scheduler = createIdleFidgetScheduler(host, FAST);
  scheduler.setEnabled(true);
  await sleep(20);
  assert.equal(host.events.length, 0, "quiet while gated");
  host.fidgetable = true;
  await sleep(30);
  scheduler.dispose();
  assert.ok(host.events.length > 0, "fidgets resume once the gate reopens");
}

async function testEmptyPoolStaysStill(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createIdleFidgetScheduler(host, { ...FAST, pool: [] });
  scheduler.setEnabled(true);
  await sleep(30);
  scheduler.dispose();
  assert.equal(host.events.length, 0, "an empty pool never fires");
}

async function testReportsBusyWindow(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createIdleFidgetScheduler(host, {
    ...FAST,
    durationMs: () => 100,
  });
  scheduler.setEnabled(true);
  await sleep(15);
  assert.equal(
    scheduler.isFidgeting(),
    true,
    "isFidgeting is true while a fidget holds the stage",
  );
  scheduler.dispose();
}

async function testDisableGoesQuiet(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createIdleFidgetScheduler(host, FAST);
  scheduler.setEnabled(true);
  await sleep(30);
  scheduler.setEnabled(false);
  const count = host.events.length;
  await sleep(30);
  scheduler.dispose();
  assert.equal(host.events.length, count, "a disabled pet stops fidgeting");
}

async function main(): Promise<void> {
  await testFiresAndRearms();
  await testPicksFromPool();
  await testAvoidsImmediateRepeatWhenPossible();
  await testGateBlocks();
  await testGateReopens();
  await testEmptyPoolStaysStill();
  await testReportsBusyWindow();
  await testDisableGoesQuiet();
  console.log("verify-idle-fidget-scheduler: ok");
}

void main();
