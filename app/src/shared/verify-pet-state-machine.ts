import assert from "node:assert/strict";

import { PET_ROWS, SHEET_COLUMNS, SHEET_ROWS } from "./animation-manifest";
import {
  INITIAL_PET_STATE,
  type PetEvent,
  type PetState,
  reducePetState,
} from "./pet-state-machine";

// Scripted event sequences against the pure reducer: the full lifecycle of a
// turn, one-shot interruptions and fallbacks, drag's absolute priority, and
// wander's strictly lowest priority. Run with:
// npm run verify:pet-state-machine -w app

function run(events: PetEvent[], from: PetState = INITIAL_PET_STATE): PetState {
  return events.reduce(reducePetState, from);
}

function main(): void {
  // The manifest's geometry must hold: no row may claim more frames than the
  // sheet has columns, no row may index past the sheet, and one-shot rows
  // must be the non-looping ones.
  for (const [name, spec] of Object.entries(PET_ROWS)) {
    assert.ok(
      spec.frames > 0 && spec.frames <= SHEET_COLUMNS,
      `${name} frame count fits the sheet`,
    );
    assert.ok(
      spec.index >= 0 && spec.index < SHEET_ROWS,
      `${name} row index fits the sheet`,
    );
    assert.ok(spec.fps > 0, `${name} has a positive fps`);
  }
  assert.equal(PET_ROWS.celebrating.loop, false, "celebrating is a one-shot");
  assert.equal(PET_ROWS.startled.loop, false, "startled is a one-shot");
  assert.equal(PET_ROWS.casting.loop, false, "casting is a one-shot");
  assert.equal(PET_ROWS.breathing.loop, false, "breathing is a one-shot");
  assert.equal(PET_ROWS.dozing.loop, false, "dozing is a one-shot");
  // Idle is a single held frame: a still pet, not a breathing loop.
  assert.equal(PET_ROWS.idle.frames, 1, "idle is a single static frame");
  // The two walks are one left-facing row, mirrored for rightward strolls.
  assert.equal(
    PET_ROWS["walking-left"].index,
    PET_ROWS["walking-right"].index,
    "the walks share one sheet row",
  );
  assert.equal(
    PET_ROWS["walking-right"].mirror,
    true,
    "walking-right draws mirrored",
  );
  // Dragging loops for as long as the hand holds her.
  assert.equal(PET_ROWS.dragging.loop, true, "dragging loops while held");

  // A full successful turn: queued -> thinking -> answering -> celebration ->
  // back to rest.
  let state = INITIAL_PET_STATE;
  assert.equal(state.row, "idle", "she starts on the static idle pose");
  state = run([{ type: "background", background: "waiting" }], state);
  assert.equal(state.row, "listening", "queued turn shows her listening");
  state = run([{ type: "background", background: "review" }], state);
  assert.equal(state.row, "thinking", "thinking deltas show the orb");
  state = run([{ type: "background", background: "running" }], state);
  assert.equal(state.row, "typing", "text deltas show her typing");
  state = run(
    [
      { type: "background", background: "idle" },
      { type: "one-shot", row: "celebrating" },
    ],
    state,
  );
  assert.equal(state.row, "celebrating", "success plays the celebration");
  state = run([{ type: "animation-complete" }], state);
  assert.deepEqual(
    state,
    INITIAL_PET_STATE,
    "the celebration falls back to the idle background",
  );

  // A background change during a one-shot waits for the animation instead of
  // cutting it off, then wins.
  state = run([
    { type: "one-shot", row: "casting" },
    { type: "background", background: "waiting" },
  ]);
  assert.equal(state.row, "casting", "the cast keeps playing");
  assert.equal(state.background, "waiting", "the new background is retained");
  state = run([{ type: "animation-complete" }], state);
  assert.equal(state.row, "listening", "the cast hands off to the wait");

  // A one-shot interrupts a looping row the moment it fires.
  state = run([
    { type: "background", background: "running" },
    { type: "one-shot", row: "startled" },
  ]);
  assert.equal(state.row, "startled", "failure interrupts streaming");
  state = run(
    [
      { type: "background", background: "idle" },
      { type: "animation-complete" },
    ],
    state,
  );
  assert.deepEqual(state, INITIAL_PET_STATE, "failure settles back to idle");

  // Stray completion events from looping rows change nothing.
  state = run([
    { type: "background", background: "waiting" },
    { type: "animation-complete" },
  ]);
  assert.equal(state.row, "listening", "loops ignore completion");

  // An idle fidget plays over the static idle pose and hands back to it.
  state = run([{ type: "one-shot", row: "breathing" }]);
  assert.equal(state.row, "breathing", "an idle breath plays");
  assert.equal(state.background, "idle", "the background stays idle under it");
  state = run([{ type: "animation-complete" }], state);
  assert.deepEqual(state, INITIAL_PET_STATE, "the breath settles back to idle");

  // A turn that starts mid-fidget is not lost: the fidget finishes, then the
  // new background takes the stage.
  state = run([
    { type: "one-shot", row: "dozing" },
    { type: "background", background: "waiting" },
  ]);
  assert.equal(state.row, "dozing", "a dozing fidget keeps playing");
  assert.equal(state.background, "waiting", "the queued turn is retained");
  state = run([{ type: "animation-complete" }], state);
  assert.equal(state.row, "listening", "the fidget hands off to the turn");

  // Wander only starts from a fully idle pet, and any activity preempts it.
  state = run([{ type: "wander", direction: "left" }]);
  assert.equal(state.row, "walking-left", "an idle pet may wander");
  state = run([{ type: "background", background: "waiting" }], state);
  assert.equal(state.row, "listening", "activity preempts a wander instantly");
  state = run([{ type: "wander", direction: "right" }], state);
  assert.equal(state.row, "listening", "a busy pet refuses to wander");
  state = run(
    [
      { type: "background", background: "idle" },
      { type: "wander", direction: "right" },
      { type: "wander-stop" },
    ],
    state,
  );
  assert.deepEqual(state, INITIAL_PET_STATE, "wander-stop returns to idle");

  // wander-stop when not wandering is a no-op.
  state = run([
    { type: "background", background: "review" },
    { type: "wander-stop" },
  ]);
  assert.equal(state.row, "thinking", "wander-stop leaves other rows alone");

  // Being picked up preempts everything, even a playing one-shot, and the
  // wiggle holds for as long as the hand does.
  state = run([{ type: "one-shot", row: "casting" }, { type: "drag" }]);
  assert.equal(state.row, "dragging", "a grab interrupts a one-shot");
  state = run([{ type: "one-shot", row: "celebrating" }], state);
  assert.equal(state.row, "dragging", "a held pet ignores one-shots");
  state = run([{ type: "animation-complete" }], state);
  assert.equal(state.row, "dragging", "stray completions leave the hold");
  state = run([{ type: "drag-stop" }], state);
  assert.deepEqual(state, INITIAL_PET_STATE, "the drop settles back to idle");

  // A turn that progresses mid-drag is reflected the moment she is dropped.
  state = run([
    { type: "background", background: "waiting" },
    { type: "drag" },
    { type: "background", background: "running" },
  ]);
  assert.equal(state.row, "dragging", "the wiggle survives turn progress");
  assert.equal(state.background, "running", "the turn's phase is retained");
  state = run([{ type: "drag-stop" }], state);
  assert.equal(state.row, "typing", "the drop lands on the current phase");

  // A drag cuts a wander short (the schedulers also stop the walk; the
  // reducer must agree), and drag-stop is a no-op when nothing is held.
  state = run([{ type: "wander", direction: "right" }, { type: "drag" }]);
  assert.equal(state.row, "dragging", "a grab interrupts a stroll");
  state = run([
    { type: "background", background: "review" },
    { type: "drag-stop" },
  ]);
  assert.equal(state.row, "thinking", "drag-stop leaves other rows alone");

  console.log("verify-pet-state-machine: ok");
}

main();
