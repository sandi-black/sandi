import type { PetDisplayEvent } from "@shared/ipc-contract";

// Wander mode: an idle pet occasionally strolls horizontally across her
// display's work area. Main owns the window position, so main drives the
// walk: pick a target x, tell the renderer to play the walking row, nudge the
// window a couple of pixels per tick, then stop and save where she ended up.
//
// Wandering is the lowest-priority behavior everywhere: the renderer's
// reducer refuses to start it unless the pet is fully idle, and this
// scheduler checks the host's canStroll gate before starting and on every
// tick, so any real activity (a turn, a drag, the chat opening) halts the
// walk within one tick. Everything Electron-flavored is injected through the
// host so the schedule logic verifies without a window.

export type WanderRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WanderHost = {
  getBounds(): WanderRect;
  setPosition(x: number, y: number): void;
  // The work area of whichever display the pet currently occupies.
  workAreaFor(bounds: WanderRect): WanderRect;
  // False whenever a stroll must not run: a turn is active, the pet is being
  // dragged or hidden, the chat popover is open. Composed by the caller.
  canStroll(): boolean;
  sendDisplayEvent(event: PetDisplayEvent): void;
  savePosition(position: { x: number; y: number }): void;
};

export type WanderOptions = {
  // Idle pause between strolls, sampled uniformly.
  pauseRangeMs?: [number, number];
  tickMs?: number;
  stepPx?: number;
  // Targets closer than this are not worth walking to; repick or skip.
  minStrollPx?: number;
  // Keep this many pixels between the sprite and the work-area edge.
  edgeMarginPx?: number;
  random?: () => number;
};

export type WanderScheduler = {
  setEnabled(enabled: boolean): void;
  // True while a stroll is underway, so the idle-fidget scheduler can hold off
  // rather than fire a fidget one-shot into the middle of a walk.
  isStrolling(): boolean;
  // Cancel an in-progress stroll (position is saved) and rearm the pause.
  // A no-op while already paused.
  interrupt(): void;
  dispose(): void;
};

const DEFAULTS: Required<WanderOptions> = {
  pauseRangeMs: [15_000, 45_000],
  tickMs: 16,
  stepPx: 2,
  minStrollPx: 60,
  edgeMarginPx: 16,
  random: Math.random,
};

export function createWanderScheduler(
  host: WanderHost,
  options: WanderOptions = {},
): WanderScheduler {
  const config = { ...DEFAULTS, ...options };

  let enabled = false;
  let disposed = false;
  let pauseTimer: NodeJS.Timeout | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let targetX: number | undefined;

  const clearTimers = (): void => {
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = undefined;
  };

  const arm = (): void => {
    if (!enabled || disposed || pauseTimer || tickTimer) return;
    const [min, max] = config.pauseRangeMs;
    const pause = min + config.random() * (max - min);
    pauseTimer = setTimeout(() => {
      pauseTimer = undefined;
      beginStroll();
    }, pause);
  };

  const endStroll = (): void => {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = undefined;
    targetX = undefined;
    host.sendDisplayEvent({ type: "wander-stop" });
    const bounds = host.getBounds();
    host.savePosition({ x: bounds.x, y: bounds.y });
    arm();
  };

  const beginStroll = (): void => {
    if (!enabled || disposed) return;
    if (!host.canStroll()) {
      arm();
      return;
    }
    const bounds = host.getBounds();
    const area = host.workAreaFor(bounds);
    const minX = area.x + config.edgeMarginPx;
    const maxX = area.x + area.width - bounds.width - config.edgeMarginPx;
    if (maxX - minX < config.minStrollPx) {
      // Work area too narrow to walk anywhere meaningful; try again later.
      arm();
      return;
    }
    const picked = minX + config.random() * (maxX - minX);
    if (Math.abs(picked - bounds.x) < config.minStrollPx) {
      arm();
      return;
    }
    targetX = Math.round(picked);
    host.sendDisplayEvent({
      type: "wander",
      direction: targetX < bounds.x ? "left" : "right",
    });
    tickTimer = setInterval(() => {
      if (!enabled || !host.canStroll() || targetX === undefined) {
        endStroll();
        return;
      }
      const current = host.getBounds();
      const remaining = targetX - current.x;
      if (Math.abs(remaining) <= config.stepPx) {
        host.setPosition(targetX, current.y);
        endStroll();
        return;
      }
      host.setPosition(
        current.x + Math.sign(remaining) * config.stepPx,
        current.y,
      );
    }, config.tickMs);
  };

  return {
    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (enabled) {
        arm();
      } else {
        endStroll();
        clearTimers();
      }
    },
    isStrolling() {
      return tickTimer !== undefined;
    },
    interrupt() {
      endStroll();
    },
    dispose() {
      disposed = true;
      enabled = false;
      clearTimers();
    },
  };
}
