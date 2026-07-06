import {
  INITIAL_PET_STATE,
  type PetEvent,
  reducePetState,
} from "@shared/pet-state-machine";

import { createSpritePlayer } from "./sprite-player";

// The pet renderer: plays the sprite, runs the pure pet state machine over
// display events from main plus its own animation completions, and turns
// pointer gestures into drag/click intents. No React here; one canvas and a
// reducer is the whole UI.

// Movement below this many pixels is a click (open chat); at or beyond it,
// the gesture becomes a drag.
const DRAG_THRESHOLD_PX = 4;

// Alpha at or below this is "empty" for click-through purposes; sprite edges
// carry faint anti-aliasing worth keeping interactive.
const ALPHA_THRESHOLD = 16;

async function main(): Promise<void> {
  const found = document.querySelector("canvas");
  if (!(found instanceof HTMLCanvasElement)) {
    throw new Error("pet canvas missing");
  }
  const canvas = found;
  const player = await createSpritePlayer(canvas);
  const bridge = window.sandiPet;

  let state = INITIAL_PET_STATE;
  const dispatch = (event: PetEvent): void => {
    state = reducePetState(state, event);
    player.setRow(state.row);
  };

  player.onOneShotComplete(() => dispatch({ type: "animation-complete" }));
  bridge.onDisplayEvent((event) => {
    if (event.type === "reply-alert") {
      player.setReplyAlertVisible(event.visible);
      return;
    }
    dispatch(event);
  });

  player.setOutfit(await bridge.getOutfit());
  bridge.onOutfitChanged((outfit) => player.setOutfit(outfit));

  // Pointer gestures. Dragging is manual: main follows the OS cursor, the
  // renderer only signals grip, ticks, and release (see pet-window.ts).
  let pointerDownAt: { x: number; y: number } | undefined;
  let dragging = false;
  let movePending = false;

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerDownAt = { x: event.screenX, y: event.screenY };
    dragging = false;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (pointerDownAt) {
      const dx = event.screenX - pointerDownAt.x;
      const dy = event.screenY - pointerDownAt.y;
      if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragging = true;
        bridge.dragStart({ x: event.screenX, y: event.screenY });
      }
      if (dragging && !movePending) {
        // One tick per animation frame is plenty; main re-reads the true
        // cursor position on every tick anyway.
        movePending = true;
        requestAnimationFrame(() => {
          movePending = false;
          bridge.dragMove({ x: 0, y: 0 });
        });
      }
      return;
    }
    updateClickThrough(event);
  });

  canvas.addEventListener("pointerup", (event) => {
    if (event.button !== 0 || !pointerDownAt) return;
    canvas.releasePointerCapture(event.pointerId);
    pointerDownAt = undefined;
    if (dragging) {
      dragging = false;
      bridge.dragEnd();
      return;
    }
    bridge.openChat();
  });

  // While the cursor rests on a transparent pixel, the whole window ignores
  // mouse input (with forwarding on, so these move events keep arriving and
  // can re-enable it). Only send transitions, not every move.
  let ignoring = false;
  function updateClickThrough(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const alpha = player.alphaAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    const shouldIgnore = alpha <= ALPHA_THRESHOLD;
    if (shouldIgnore !== ignoring) {
      ignoring = shouldIgnore;
      bridge.setIgnoreMouseEvents(shouldIgnore);
    }
  }
}

main().catch((error: unknown) => {
  // The pet has no UI to report into; the devtools console is the surface.
  console.error("pet renderer failed to start", error);
});
