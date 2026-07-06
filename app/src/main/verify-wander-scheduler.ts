import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import type { PetDisplayEvent } from "@shared/ipc-contract";

import {
  createWanderScheduler,
  type WanderHost,
  type WanderOptions,
  type WanderRect,
} from "./wander-scheduler";

// Exercises the wander scheduler against a fake host with millisecond-scale
// timings: strolls start after the pause, walk to the picked target, emit
// wander then wander-stop, save the landing position, and yield instantly to
// the canStroll gate, interrupts, and disable.
// Run with: npm run verify:wander-scheduler -w app

type FakeHost = WanderHost & {
  bounds: WanderRect;
  strollable: boolean;
  events: PetDisplayEvent[];
  saved: { x: number; y: number }[];
};

function createFakeHost(): FakeHost {
  const host: FakeHost = {
    bounds: { x: 500, y: 900, width: 192, height: 208 },
    strollable: true,
    events: [],
    saved: [],
    getBounds: () => ({ ...host.bounds }),
    setPosition(x, y) {
      host.bounds.x = x;
      host.bounds.y = y;
    },
    workAreaFor: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    canStroll: () => host.strollable,
    sendDisplayEvent: (event) => host.events.push(event),
    savePosition: (position) => host.saved.push(position),
  };
  return host;
}

// Fast, deterministic config: no pause, 1ms ticks, big steps, and a fixed
// random so the target is always the same spot.
const FAST: WanderOptions = {
  pauseRangeMs: [0, 0],
  tickMs: 1,
  stepPx: 50,
  minStrollPx: 60,
  edgeMarginPx: 16,
};

async function testCompletesAStroll(): Promise<void> {
  const host = createFakeHost();
  // random 0.9 → target near the right edge, far from x=500.
  const scheduler = createWanderScheduler(host, { ...FAST, random: () => 0.9 });
  scheduler.setEnabled(true);
  await sleep(100);
  scheduler.dispose();

  const first = host.events[0];
  assert.ok(first && first.type === "wander", "stroll announces itself");
  assert.equal(first.direction, "right", "target right of start walks right");
  assert.ok(
    host.events.some((event) => event.type === "wander-stop"),
    "stroll ends with wander-stop",
  );
  const expectedTarget = Math.round(16 + 0.9 * (1920 - 192 - 32));
  assert.equal(host.bounds.x, expectedTarget, "walked exactly to the target");
  assert.equal(host.bounds.y, 900, "a stroll never changes y");
  const landing = host.saved.at(-1);
  assert.ok(landing, "landing position saved");
  assert.equal(landing.x, expectedTarget, "saved position is the landing");
}

async function testWalksLeft(): Promise<void> {
  const host = createFakeHost();
  host.bounds.x = 1600;
  const scheduler = createWanderScheduler(host, { ...FAST, random: () => 0.1 });
  scheduler.setEnabled(true);
  await sleep(100);
  scheduler.dispose();
  const first = host.events[0];
  assert.ok(first && first.type === "wander", "stroll started");
  assert.equal(first.direction, "left", "target left of start walks left");
  assert.ok(host.bounds.x < 1600, "moved leftward");
}

async function testGateBlocksStrolls(): Promise<void> {
  const host = createFakeHost();
  host.strollable = false;
  const scheduler = createWanderScheduler(host, { ...FAST, random: () => 0.9 });
  scheduler.setEnabled(true);
  await sleep(30);
  scheduler.dispose();
  assert.equal(host.events.length, 0, "gated pet never strolls");
  assert.equal(host.bounds.x, 500, "gated pet never moves");
}

async function testGateHaltsMidStroll(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createWanderScheduler(host, {
    ...FAST,
    stepPx: 1,
    random: () => 0.9,
  });
  scheduler.setEnabled(true);
  await sleep(20);
  assert.ok(
    host.events.some((event) => event.type === "wander"),
    "stroll underway",
  );
  // Simulate a turn starting mid-walk: the gate closes.
  host.strollable = false;
  await sleep(20);
  const haltedAt = host.bounds.x;
  assert.ok(
    host.events.some((event) => event.type === "wander-stop"),
    "closing the gate stops the walk",
  );
  await sleep(20);
  assert.equal(host.bounds.x, haltedAt, "no movement after the halt");
  assert.ok(host.saved.length > 0, "halt position saved");
  scheduler.dispose();
}

async function testInterruptAndDisable(): Promise<void> {
  const host = createFakeHost();
  const scheduler = createWanderScheduler(host, {
    ...FAST,
    stepPx: 1,
    random: () => 0.9,
  });
  scheduler.setEnabled(true);
  await sleep(20);
  // Interrupt cancels the walk and rearms the pause; with this test's zero
  // pause the next stroll would start immediately, so disable right away to
  // observe the frozen position.
  scheduler.interrupt();
  scheduler.setEnabled(false);
  const haltedAt = host.bounds.x;
  assert.ok(
    host.events.some((event) => event.type === "wander-stop"),
    "interrupt stops the walk",
  );
  const eventCount = host.events.length;
  await sleep(30);
  assert.equal(host.bounds.x, haltedAt, "no movement after interrupt");
  assert.equal(host.events.length, eventCount, "disabled pet stays put");
  scheduler.dispose();
}

async function testNeverEscapesWorkArea(): Promise<void> {
  const host = createFakeHost();
  host.bounds.x = 30;
  const scheduler = createWanderScheduler(host, {
    ...FAST,
    random: () => 0.999,
  });
  scheduler.setEnabled(true);
  await sleep(150);
  scheduler.dispose();
  assert.ok(host.bounds.x >= 16, "stays inside the left margin");
  assert.ok(host.bounds.x <= 1920 - 192 - 16, "stays inside the right margin");
}

async function main(): Promise<void> {
  await testCompletesAStroll();
  await testWalksLeft();
  await testGateBlocksStrolls();
  await testGateHaltsMidStroll();
  await testInterruptAndDisable();
  await testNeverEscapesWorkArea();
  console.log("verify-wander-scheduler: ok");
}

void main();
