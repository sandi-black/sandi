import assert from "node:assert/strict";

import {
  clampIntoWorkArea,
  clampSizeIntoWorkArea,
  computeAnchoredPosition,
  computeOffsetPosition,
  computeResizedBounds,
  type Rect,
} from "./window-anchor";

// Placement rules across the flip and clamp cases, with synthetic display
// geometry. Run with: npm run verify:anchor-position -w app

const CHAT = { width: 380, height: 560 };
// A 1920x1080 primary display with a 40px taskbar.
const WORK: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const PET_SIZE = { width: 192, height: 208 };

function petAt(x: number, y: number): Rect {
  return { x, y, ...PET_SIZE };
}

function main(): void {
  // Room on the right: the popover sits beside the pet with its bottom
  // aligned to the pet's bottom.
  let pos = computeAnchoredPosition(petAt(600, 600), CHAT, WORK);
  assert.deepEqual(pos, { x: 600 + 192 + 12, y: 600 + 208 - 560 });

  // Near the right edge: flips to the left side.
  pos = computeAnchoredPosition(petAt(1700, 600), CHAT, WORK);
  assert.deepEqual(pos, { x: 1700 - 12 - 380, y: 600 + 208 - 560 });

  // Near the top: y clamps into the work area.
  pos = computeAnchoredPosition(petAt(600, 10), CHAT, WORK);
  assert.equal(pos.y, 0, "clamped to the top of the work area");

  // Near the bottom: bottom-aligned placement stays inside the work area.
  pos = computeAnchoredPosition(petAt(600, 1000), CHAT, WORK);
  assert.equal(pos.y, WORK.height - CHAT.height, "clamped above the taskbar");

  // A secondary display with a negative origin (mounted left of primary).
  const leftDisplay: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
  pos = computeAnchoredPosition(petAt(-1500, 500), CHAT, leftDisplay);
  assert.deepEqual(
    pos,
    { x: -1500 + 192 + 12, y: 500 + 208 - 560 },
    "prefers the right side in negative coordinates",
  );
  // Near that display's right edge (x approaches 0): flips left.
  pos = computeAnchoredPosition(petAt(-300, 500), CHAT, leftDisplay);
  assert.deepEqual(pos, { x: -300 - 12 - 380, y: 500 + 208 - 560 });
  pos = computeAnchoredPosition(petAt(-450, 500), CHAT, leftDisplay);
  assert.ok(
    pos.x + CHAT.width <= leftDisplay.x + leftDisplay.width,
    "never overflows the display",
  );

  // A display too narrow for either side still yields an in-bounds position.
  const narrow: Rect = { x: 0, y: 0, width: 500, height: 800 };
  pos = computeAnchoredPosition(petAt(150, 300), CHAT, narrow);
  assert.ok(pos.x >= narrow.x, "left edge in bounds");
  assert.ok(
    pos.x + CHAT.width <= narrow.x + narrow.width,
    "right edge in bounds",
  );

  // Restore-position clamping: a stale position from an unplugged monitor
  // lands fully inside the surviving display.
  const restored = clampIntoWorkArea({ x: 4000, y: -2000 }, PET_SIZE, WORK);
  assert.deepEqual(restored, {
    x: WORK.width - PET_SIZE.width,
    y: 0,
  });
  // An in-bounds position is untouched.
  assert.deepEqual(clampIntoWorkArea({ x: 50, y: 60 }, PET_SIZE, WORK), {
    x: 50,
    y: 60,
  });

  // Saved-offset placement: the popover lands at pet plus offset, wherever
  // the human left it relative to her.
  pos = computeOffsetPosition(petAt(600, 600), { x: 240, y: -300 }, CHAT, WORK);
  assert.deepEqual(pos, { x: 840, y: 300 });
  // Offsets are pure deltas, so they carry unchanged onto a display with a
  // negative origin.
  pos = computeOffsetPosition(
    petAt(-1500, 500),
    { x: 220, y: -100 },
    CHAT,
    leftDisplay,
  );
  assert.deepEqual(pos, { x: -1280, y: 400 });

  // An offset that would land past an edge clamps into the work area for
  // this placement; the stored offset itself is the caller's to keep.
  pos = computeOffsetPosition(petAt(1800, 900), { x: 400, y: 400 }, CHAT, WORK);
  assert.deepEqual(pos, {
    x: WORK.width - CHAT.width,
    y: WORK.height - CHAT.height,
  });
  // A wildly off-screen offset (saved against a monitor since unplugged)
  // still lands fully visible.
  pos = computeOffsetPosition(
    petAt(10, 10),
    { x: -4000, y: -4000 },
    CHAT,
    WORK,
  );
  assert.deepEqual(pos, { x: 0, y: 0 });

  // Size restore: a fitting size is untouched; one saved on a bigger monitor
  // shrinks to the current work area.
  const MIN = { width: 320, height: 360 };
  assert.deepEqual(
    clampSizeIntoWorkArea({ width: 400, height: 600 }, MIN, WORK),
    { width: 400, height: 600 },
  );
  assert.deepEqual(
    clampSizeIntoWorkArea({ width: 2400, height: 1600 }, MIN, WORK),
    { width: WORK.width, height: WORK.height },
  );
  // The minimum wins over a work area smaller than it, and raises a corrupt
  // or hand-shrunk saved size back to usable.
  const tiny: Rect = { x: 0, y: 0, width: 300, height: 200 };
  assert.deepEqual(
    clampSizeIntoWorkArea({ width: 400, height: 600 }, MIN, tiny),
    MIN,
  );
  assert.deepEqual(
    clampSizeIntoWorkArea({ width: 100, height: 100 }, MIN, WORK),
    MIN,
  );

  // Manual resize gestures. An east grip grows only the width; the origin
  // stays put.
  const start: Rect = { x: 100, y: 100, width: 400, height: 600 };
  let next = computeResizedBounds(start, "e", { x: 40, y: 999 }, MIN);
  assert.deepEqual(next, { x: 100, y: 100, width: 440, height: 600 });
  // A west grip moves the origin and shrinks the width; the right edge
  // (x + width) never drifts, even when the minimum stops the shrink.
  next = computeResizedBounds(start, "w", { x: 30, y: 0 }, MIN);
  assert.deepEqual(next, { x: 130, y: 100, width: 370, height: 600 });
  next = computeResizedBounds(start, "w", { x: 300, y: 0 }, MIN);
  assert.deepEqual(next, {
    x: 500 - MIN.width,
    y: 100,
    width: MIN.width,
    height: 600,
  });
  // A north grip pins the bottom edge through a min-height clamp the same way.
  next = computeResizedBounds(start, "n", { x: 0, y: 500 }, MIN);
  assert.deepEqual(next, {
    x: 100,
    y: 700 - MIN.height,
    width: 400,
    height: MIN.height,
  });
  // Corners move both axes at once.
  next = computeResizedBounds(start, "se", { x: -20, y: 50 }, MIN);
  assert.deepEqual(next, { x: 100, y: 100, width: 380, height: 650 });
  next = computeResizedBounds(start, "nw", { x: -10, y: -25 }, MIN);
  assert.deepEqual(next, { x: 90, y: 75, width: 410, height: 625 });

  console.log("verify-anchor-position: ok");
}

main();
