import assert from "node:assert/strict";

import {
  clampIntoWorkArea,
  computeAnchoredPosition,
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

  console.log("verify-anchor-position: ok");
}

main();
