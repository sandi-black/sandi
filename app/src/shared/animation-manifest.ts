// Frame geometry and row inventory for the pet spritesheet
// (assets/sandi-spritesheet.webp): 8 columns by 10 rows of 192x208 frames, one
// row per animation, composed from the v2 per-animation sheets by
// scripts/build-spritesheet.mjs. Row indexes here must match the ROWS order in
// that script. The sheet is fixed art, so this is a typed constant rather than
// runtime-loaded JSON.

export const FRAME_WIDTH = 192;
export const FRAME_HEIGHT = 208;
export const SHEET_COLUMNS = 8;
export const SHEET_ROWS = 10;
export const SHEET_WIDTH = FRAME_WIDTH * SHEET_COLUMNS;
export const SHEET_HEIGHT = FRAME_HEIGHT * SHEET_ROWS;
export const SLEEP_HOLD_RANGE_MS: readonly [number, number] = [10_000, 30_000];

export type PetRow =
  | "idle"
  | "breathing"
  | "walking-right"
  | "walking-left"
  | "listening"
  | "thinking"
  | "typing"
  | "celebrating"
  | "startled"
  | "casting"
  | "dozing"
  | "sleeping"
  | "waking"
  | "dragging";

export type RowSpec = {
  // Row index into the sheet, top to bottom.
  index: number;
  frames: number;
  fps: number;
  // Looping rows play until the state machine moves on; one-shot rows play
  // once and then report animation-complete so the machine can fall back.
  loop: boolean;
  // Selects a run within a source row. Sleeping holds the nap artwork's final
  // frame, while waking reuses that row in reverse so getting up reads as the
  // natural continuation of lying down.
  frameOffset?: number;
  reverse?: boolean;
  // Drawn flipped horizontally. The walk art drifts left (hair trailing
  // right), so the rightward walk is the same row mirrored at draw time
  // instead of a duplicate row.
  mirror?: boolean;
};

export const PET_ROWS: Record<PetRow, RowSpec> = {
  // Idle is deliberately a single held frame (row 0, frame 0): a still pet at
  // rest. The full breathing/blink cycle lives in `breathing`, played only as
  // an occasional idle fidget. A one-frame looping row never advances and
  // never reports completion, so the player simply holds it.
  idle: { index: 0, frames: 1, fps: 1, loop: true },
  breathing: { index: 0, frames: 8, fps: 6, loop: false },
  "walking-left": { index: 1, frames: 8, fps: 10, loop: true },
  "walking-right": { index: 1, frames: 8, fps: 10, loop: true, mirror: true },
  listening: { index: 2, frames: 8, fps: 8, loop: true },
  thinking: { index: 3, frames: 8, fps: 8, loop: true },
  typing: { index: 4, frames: 8, fps: 10, loop: true },
  celebrating: { index: 5, frames: 8, fps: 10, loop: false },
  startled: { index: 6, frames: 8, fps: 8, loop: false },
  casting: { index: 7, frames: 8, fps: 8, loop: false },
  // Slow on purpose: a yawn read at streaming speed looks like a hiccup.
  dozing: { index: 8, frames: 8, fps: 5, loop: false },
  sleeping: { index: 8, frames: 1, fps: 1, loop: true, frameOffset: 7 },
  waking: { index: 8, frames: 8, fps: 7, loop: false, reverse: true },
  dragging: { index: 9, frames: 8, fps: 10, loop: true },
};
