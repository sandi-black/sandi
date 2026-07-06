// Frame geometry and row inventory for the pet spritesheets. Both outfits
// (assets/sandi-spritesheet.webp and the alternate) share one 1536x1872 layout:
// 8 columns by 9 rows of 192x208 frames, rows padded with empty cells past
// their frame count. The sheets are fixed art, so this is a typed constant
// rather than runtime-loaded JSON.

export const FRAME_WIDTH = 192;
export const FRAME_HEIGHT = 208;
export const SHEET_COLUMNS = 8;
export const SHEET_ROWS = 9;
export const SHEET_WIDTH = FRAME_WIDTH * SHEET_COLUMNS;
export const SHEET_HEIGHT = FRAME_HEIGHT * SHEET_ROWS;

export type PetRow =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "blink"
  | "sleeping";

export type RowSpec = {
  // Row index into the sheet, top to bottom.
  index: number;
  frames: number;
  fps: number;
  // Looping rows play until the state machine moves on; one-shot rows play
  // once and then report animation-complete so the machine can fall back.
  loop: boolean;
};

export const PET_ROWS: Record<PetRow, RowSpec> = {
  // Idle is deliberately a single held frame (row 0, frame 0): a still pet at
  // rest. Her old constant breathing loop now lives in `blink`, played only as
  // an occasional idle fidget. A one-frame looping row never advances and never
  // reports completion, so the player simply holds it.
  idle: { index: 0, frames: 1, fps: 1, loop: true },
  "running-right": { index: 1, frames: 8, fps: 12, loop: true },
  "running-left": { index: 2, frames: 8, fps: 12, loop: true },
  waving: { index: 3, frames: 4, fps: 8, loop: false },
  jumping: { index: 4, frames: 5, fps: 10, loop: false },
  failed: { index: 5, frames: 8, fps: 8, loop: false },
  waiting: { index: 6, frames: 6, fps: 6, loop: true },
  running: { index: 7, frames: 6, fps: 10, loop: true },
  review: { index: 8, frames: 6, fps: 8, loop: true },
  // Idle fidgets: brief one-shots that play over the static idle pose and hand
  // back to it. `blink` is row 0's full breathing/blink cycle; `sleeping`
  // reuses row 5's drowsy head-droop art (the same frames the `failed` one-shot
  // draws, but fired while resting rather than on a failed turn).
  blink: { index: 0, frames: 6, fps: 6, loop: false },
  sleeping: { index: 5, frames: 8, fps: 8, loop: false },
};

export type PetOutfit = "classic" | "alternate";
