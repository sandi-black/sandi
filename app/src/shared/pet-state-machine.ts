import type { PetRow } from "./animation-manifest";

// The pet's animation is driven by two layers: a *background* row that reflects
// what sandi is doing right now (idle, waiting on a queued turn, streaming
// text, thinking), and *one-shot* rows (waving, jumping, failed) that briefly
// interrupt it and then fall back. The main process derives background changes
// and one-shots from real turn/link events; the renderer feeds
// animation-complete back when a one-shot finishes playing. Keeping the whole
// policy in this pure reducer makes it verifiable without a canvas or Electron.

export type PetBackground = "idle" | "waiting" | "running" | "review";
export type PetOneShot = "waving" | "jumping" | "failed";
export type WanderDirection = "left" | "right";

export type PetState = {
  row: PetRow;
  background: PetBackground;
};

export type PetEvent =
  | { type: "background"; background: PetBackground }
  | { type: "one-shot"; row: PetOneShot }
  | { type: "animation-complete" }
  | { type: "wander"; direction: WanderDirection }
  | { type: "wander-stop" };

export const INITIAL_PET_STATE: PetState = { row: "idle", background: "idle" };

const ONE_SHOT_ROWS: readonly PetRow[] = ["waving", "jumping", "failed"];
const WANDER_ROWS: readonly PetRow[] = ["running-left", "running-right"];

export function isOneShotRow(row: PetRow): boolean {
  return ONE_SHOT_ROWS.includes(row);
}

export function isWanderRow(row: PetRow): boolean {
  return WANDER_ROWS.includes(row);
}

export function reducePetState(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "background": {
      // A playing one-shot keeps the stage; the new background takes over when
      // it completes. Anything else (including a wander, which only exists
      // while idle) yields to the new background immediately.
      if (isOneShotRow(state.row)) {
        return { row: state.row, background: event.background };
      }
      return { row: event.background, background: event.background };
    }
    case "one-shot":
      return { row: event.row, background: state.background };
    case "animation-complete": {
      if (isOneShotRow(state.row)) {
        return { row: state.background, background: state.background };
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
        row: event.direction === "left" ? "running-left" : "running-right",
        background: state.background,
      };
    }
    case "wander-stop": {
      if (isWanderRow(state.row)) {
        return { row: state.background, background: state.background };
      }
      return state;
    }
  }
}
