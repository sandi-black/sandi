// Pure geometry for placing the chat popover next to the pet. Kept free of
// Electron imports so the placement rules are verifiable as plain functions.

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

function clamp(value: number, min: number, max: number): number {
  // A window larger than the work area pins to the area's origin rather than
  // oscillating between an inverted min/max.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
