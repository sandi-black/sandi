import type { PetRow } from "./animation-manifest";

// The pet's animation is driven by three layers: a *background* row that
// reflects what sandi is doing right now (idle, waiting on a queued turn,
// streaming text, thinking), *one-shot* rows (celebrating, startled, casting,
// plus the idle fidgets breathing and dozing) that briefly interrupt it and
// then fall back, and *held* rows (dragging, wandering) that track a physical
// gesture and end on their own stop event. The main process derives background
// changes and one-shots from real turn/link events (and from the idle-fidget
// scheduler); the renderer feeds animation-complete back when a one-shot
// finishes playing, and dispatches drag events from its own pointer gestures.
// Keeping the whole policy in this pure reducer makes it verifiable without a
// canvas or Electron.

export type PetBackground = "idle" | "waiting" | "running" | "review";
export type PetOneShot =
  | "celebrating"
  | "startled"
  | "casting"
  | "breathing"
  | "dozing";
export type WanderDirection = "left" | "right";

// How each background renders. Backgrounds carry meaning (queued vs streaming
// vs thinking) and precedence; the row is the animation shown for it. `idle`
// holds a static frame, waiting shows her listening for the request, review is
// her thinking with the orb, and running types the answer out.
const BACKGROUND_ROW: Record<PetBackground, PetRow> = {
  idle: "idle",
  waiting: "listening",
  running: "typing",
  review: "thinking",
};

export type PetState = {
  row: PetRow;
  background: PetBackground;
};

export type PetEvent =
  | { type: "background"; background: PetBackground }
  | { type: "one-shot"; row: PetOneShot }
  | { type: "animation-complete" }
  | { type: "wander"; direction: WanderDirection }
  | { type: "wander-stop" }
  | { type: "drag" }
  | { type: "drag-stop" };

export const INITIAL_PET_STATE: PetState = { row: "idle", background: "idle" };

const ONE_SHOT_ROWS: readonly PetRow[] = [
  "celebrating",
  "startled",
  "casting",
  "breathing",
  "dozing",
];
const WANDER_ROWS: readonly PetRow[] = ["walking-left", "walking-right"];

export function isOneShotRow(row: PetRow): boolean {
  return ONE_SHOT_ROWS.includes(row);
}

export function isWanderRow(row: PetRow): boolean {
  return WANDER_ROWS.includes(row);
}

export function reducePetState(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "background": {
      // A playing one-shot keeps the stage, as does a drag in progress; the
      // new background takes over when they end. Anything else (including a
      // wander, which only exists while idle) yields to the new background
      // immediately.
      if (isOneShotRow(state.row) || state.row === "dragging") {
        return { row: state.row, background: event.background };
      }
      return {
        row: BACKGROUND_ROW[event.background],
        background: event.background,
      };
    }
    case "one-shot": {
      // A held pet stays held: a turn settling mid-drag must not swap the
      // wiggle out from under the hand. The background already reflects the
      // settle, so nothing is lost when the drag ends.
      if (state.row === "dragging") return state;
      return { row: event.row, background: state.background };
    }
    case "animation-complete": {
      if (isOneShotRow(state.row)) {
        return {
          row: BACKGROUND_ROW[state.background],
          background: state.background,
        };
      }
      // Looping rows do not complete; a stray completion event is a no-op.
      return state;
    }
    case "wander": {
      // Wandering is the lowest-priority behavior: it may only start from a
      // fully idle pet, so any real activity preempts it by never letting it
      // begin.
      if (state.row !== "idle" || state.background !== "idle") return state;
      return {
        row: event.direction === "left" ? "walking-left" : "walking-right",
        background: state.background,
      };
    }
    case "wander-stop": {
      if (isWanderRow(state.row)) {
        return {
          row: BACKGROUND_ROW[state.background],
          background: state.background,
        };
      }
      return state;
    }
    case "drag": {
      // Being picked up preempts everything: whatever was playing, she is in
      // the hand now. The background survives underneath for the drop.
      return { row: "dragging", background: state.background };
    }
    case "drag-stop": {
      if (state.row !== "dragging") return state;
      return {
        row: BACKGROUND_ROW[state.background],
        background: state.background,
      };
    }
  }
}
