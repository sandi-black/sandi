import { PET_ROWS } from "@shared/animation-manifest";
import type { PetDisplayEvent } from "@shared/ipc-contract";
import type { PetOneShot } from "@shared/pet-state-machine";

// Idle fidgets: while the pet is fully idle she rests on a single static frame
// and, now and then, plays one brief in-place animation (a breath and blink, a
// bit of spell practice, a drowsy yawn) before settling back to stillness. This is the calm cousin of
// the wander scheduler: it shares the same idle-only gating but never moves the
// window, it only asks the renderer to play a one-shot row. Timing and the
// random pick are injected so the schedule verifies without a clock or a canvas.

export type IdleFidgetHost = {
  // False whenever a fidget must not fire: a turn is active, the pet is hidden
  // or being dragged, the chat is open, or she is mid-stroll. Composed by the
  // caller so this module stays free of window state.
  canFidget(): boolean;
  sendDisplayEvent(event: PetDisplayEvent): void;
};

export type IdleFidgetOptions = {
  // Quiet stretch between fidgets, sampled uniformly.
  pauseRangeMs?: [number, number];
  // The rows she may play as a fidget. Repeating a row in this list weights it.
  pool?: readonly PetOneShot[];
  // How long each fidget holds the stage before the pause rearms; defaults to
  // the row's own frame budget. Injectable so the schedule verifies at ms scale.
  durationMs?: (row: PetOneShot) => number;
  random?: () => number;
};

export type IdleFidgetScheduler = {
  setEnabled(enabled: boolean): void;
  // True while a fidget one-shot is still playing, so the wander scheduler can
  // hold off rather than move the window out from under an animation.
  isFidgeting(): boolean;
  // Cancel a pending fidget and rearm the pause. A no-op while one is on stage
  // (it is momentary and rearms itself when it finishes).
  interrupt(): void;
  dispose(): void;
};

// How long a one-shot row holds the stage, from its own frame budget, so the
// "busy" window matches what the renderer actually plays.
function rowDurationMs(row: PetOneShot): number {
  const spec = PET_ROWS[row];
  return Math.ceil((spec.frames / spec.fps) * 1000);
}

const DEFAULTS: Required<IdleFidgetOptions> = {
  pauseRangeMs: [8_000, 28_000],
  // Weighted: the subtle breath is the common fidget; the flashier spell
  // practice and drowsy yawn stay occasional.
  pool: ["breathing", "breathing", "breathing", "casting", "dozing"],
  durationMs: rowDurationMs,
  random: Math.random,
};

export function createIdleFidgetScheduler(
  host: IdleFidgetHost,
  options: IdleFidgetOptions = {},
): IdleFidgetScheduler {
  const config = { ...DEFAULTS, ...options };

  let enabled = false;
  let disposed = false;
  let pauseTimer: NodeJS.Timeout | undefined;
  let busyTimer: NodeJS.Timeout | undefined;
  let previousRow: PetOneShot | undefined;

  const clearTimers = (): void => {
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = undefined;
  };

  const arm = (): void => {
    if (!enabled || disposed || pauseTimer || busyTimer) return;
    const [min, max] = config.pauseRangeMs;
    const pause = min + config.random() * (max - min);
    pauseTimer = setTimeout(() => {
      pauseTimer = undefined;
      fidget();
    }, pause);
  };

  const fidget = (): void => {
    if (!enabled || disposed) return;
    const candidates = previousRow
      ? config.pool.filter((candidate) => candidate !== previousRow)
      : config.pool;
    const pool = candidates.length > 0 ? candidates : config.pool;
    const row = pool[Math.floor(config.random() * pool.length)];
    if (!row || !host.canFidget()) {
      // Not a good moment (or an empty pool): stay still and try again later.
      arm();
      return;
    }
    previousRow = row;
    host.sendDisplayEvent({ type: "one-shot", row });
    // Hold "busy" for the row's own run so the wander scheduler stays parked
    // until she has settled back to the static idle frame, then rearm.
    busyTimer = setTimeout(() => {
      busyTimer = undefined;
      arm();
    }, config.durationMs(row));
  };

  return {
    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (enabled) {
        arm();
      } else {
        clearTimers();
      }
    },
    isFidgeting() {
      return busyTimer !== undefined;
    },
    interrupt() {
      // A fidget already on stage is momentary; let it finish and rearm itself.
      // Otherwise cancel the pending pause and restart it, so a fidget cannot
      // pop the instant real activity begins.
      if (busyTimer) return;
      clearTimers();
      arm();
    },
    dispose() {
      disposed = true;
      enabled = false;
      clearTimers();
    },
  };
}
