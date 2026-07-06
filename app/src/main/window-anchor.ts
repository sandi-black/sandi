// Pure geometry for placing, restoring, and resizing the chat popover. Kept
// free of Electron imports so the rules are verifiable as plain functions.

import type { ResizeEdge } from "@shared/ipc-contract";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

// How far the popover sits from the pet, so the sprite is not covered.
const GAP = 12;

// Places the chat window beside the pet, preferring the right side and
// flipping horizontally when it would overflow the work area. Vertically it
// aligns the popover's bottom with the pet's bottom (a speech-bubble feel) and
// clamps into the work area. The final clamp also covers a pet dragged
// half off-screen: the popover always lands fully visible.
export function computeAnchoredPosition(
  petBounds: Rect,
  chatSize: Size,
  workArea: Rect,
): Point {
  const rightX = petBounds.x + petBounds.width + GAP;
  const leftX = petBounds.x - GAP - chatSize.width;
  const fitsRight = rightX + chatSize.width <= workArea.x + workArea.width;
  const fitsLeft = leftX >= workArea.x;
  let x: number;
  if (fitsRight) {
    x = rightX;
  } else if (fitsLeft) {
    x = leftX;
  } else {
    // Neither side fits (tiny display or a pet mid-screen on a narrow work
    // area): fall back to whichever side leaves more room, then clamp.
    x = rightX;
  }

  const y = petBounds.y + petBounds.height - chatSize.height;

  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - chatSize.width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - chatSize.height),
  };
}

// Places the chat at the human's saved offset from the pet's top-left,
// clamped into the work area. The clamp handles an offset that no longer fits
// (the pet near a screen edge, a smaller display since last run) for this
// placement only; the caller keeps the stored offset untouched so the intent
// survives the temporary geometry.
export function computeOffsetPosition(
  petBounds: Rect,
  offset: Point,
  chatSize: Size,
  workArea: Rect,
): Point {
  return clampIntoWorkArea(
    { x: petBounds.x + offset.x, y: petBounds.y + offset.y },
    chatSize,
    workArea,
  );
}

// Shrinks a restored window size to fit the work area. The minimum wins over
// an absurdly small work area: a barely-overflowing window beats one crushed
// past usability.
export function clampSizeIntoWorkArea(
  size: Size,
  minSize: Size,
  workArea: Rect,
): Size {
  return {
    width: Math.max(Math.min(size.width, workArea.width), minSize.width),
    height: Math.max(Math.min(size.height, workArea.height), minSize.height),
  };
}

// Clamps a restored window position into the given work area so a monitor
// unplugged since last run cannot strand the window off-screen.
export function clampIntoWorkArea(
  position: Point,
  size: Size,
  workArea: Rect,
): Point {
  return {
    x: clamp(position.x, workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(
      position.y,
      workArea.y,
      workArea.y + workArea.height - size.height,
    ),
  };
}

// Applies a resize gesture's cursor delta to the window's starting bounds.
// The edge names which sides follow the cursor; the opposite sides stay
// pinned, including when the minimum size stops a shrink (a north or west
// grip must never let the fixed south or east edge drift).
export function computeResizedBounds(
  start: Rect,
  edge: ResizeEdge,
  delta: Point,
  minSize: Size,
): Rect {
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (edge.includes("e")) right += delta.x;
  if (edge.includes("w")) left += delta.x;
  if (edge.includes("s")) bottom += delta.y;
  if (edge.includes("n")) top += delta.y;
  if (right - left < minSize.width) {
    if (edge.includes("w")) {
      left = right - minSize.width;
    } else {
      right = left + minSize.width;
    }
  }
  if (bottom - top < minSize.height) {
    if (edge.includes("n")) {
      top = bottom - minSize.height;
    } else {
      bottom = top + minSize.height;
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, min: number, max: number): number {
  // A window larger than the work area pins to the area's origin rather than
  // oscillating between an inverted min/max.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
