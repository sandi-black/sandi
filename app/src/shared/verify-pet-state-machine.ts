import assert from "node:assert/strict";

import { PET_ROWS, SHEET_COLUMNS } from "./animation-manifest";
import {
  INITIAL_PET_STATE,
  type PetEvent,
  type PetState,
  reducePetState,
} from "./pet-state-machine";

// Scripted event sequences against the pure reducer: the full lifecycle of a
// turn, one-shot interruptions and fallbacks, and wander's strictly lowest
// priority. Run with: npm run verify:pet-state-machine -w app

function run(events: PetEvent[], from: PetState = INITIAL_PET_STATE): PetState {
  return events.reduce(reducePetState, from);
}

function main(): void {
  // The manifest's geometry must hold: no row may claim more frames than the
  // sheet has columns, and one-shot rows must be the non-looping ones.
  for (const [name, spec] of Object.entries(PET_ROWS)) {
    assert.ok(
      spec.frames > 0 && spec.frames <= SHEET_COLUMNS,
      `${name} frame count fits the sheet`,
    );
    assert.ok(spec.fps > 0, `${name} has a positive fps`);
  }
  assert.equal(PET_ROWS.waving.loop, false, "waving is a one-shot");
  assert.equal(PET_ROWS.jumping.loop, false, "jumping is a one-shot");
  assert.equal(PET_ROWS.failed.loop, false, "failed is a one-shot");
  assert.equal(PET_ROWS.blink.loop, false, "blink is a one-shot");
  assert.equal(PET_ROWS.sleeping.loop, false, "sleeping is a one-shot");
  // Idle is a single held frame: a still pet, not a breathing loop.
  assert.equal(PET_ROWS.idle.frames, 1, "idle is a single static frame");

  // A full successful turn: queued -> thinking -> answering -> celebration ->
  // back to rest.
  let state = INITIAL_PET_STATE;
  assert.equal(state.row, "idle", "she starts on the static idle pose");
  state = run([{ type: "background", background: "waiting" }], state);
  assert.equal(state.row, "waiting", "queued turn shows waiting");
  state = run([{ type: "background", background: "review" }], state);
  assert.equal(state.row, "review", "thinking deltas show review");
  state = run([{ type: "background", background: "running" }], state);
  // Streaming an answer shares the calm review animation: the run-in-place row
  // is never shown while she is parked at work.
  assert.equal(state.row, "review", "text deltas share the review animation");
  assert.equal(state.background, "running", "but the background stays running");
  state = run(
    [
      { type: "background", background: "idle" },
      { type: "one-shot", row: "jumping" },
    ],
    state,
  );
  assert.equal(state.row, "jumping", "success plays the jump");
  state = run([{ type: "animation-complete" }], state);
  assert.deepEqual(
    state,
    INITIAL_PET_STATE,
    "the jump falls back to the idle background",
  );

  // A background change during a one-shot waits for the animation instead of
  // cutting it off, then wins.
  state = run([
    { type: "one-shot", row: "waving" },
    { type: "background", background: "waiting" },
  ]);
  assert.equal(state.row, "waving", "the wave keeps playing");
  assert.equal(state.background, "waiting", "the new background is retained");
  state = run([{ type: "animation-complete" }], state);
  assert.equal(state.row, "waiting", "the wave hands off to the wait");

  // A one-shot interrupts a looping row the moment it fires.
  state = run([
    { type: "background", background: "running" },
    { type: "one-shot", row: "failed" },
  ]);
  assert.equal(state.row, "failed", "failure interrupts streaming");
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
  assert.equal(state.row, "waiting", "loops ignore completion");

  // An idle fidget plays over the static idle pose and hands back to it.
  state = run([{ type: "one-shot", row: "blink" }]);
  assert.equal(state.row, "blink", "an idle blink plays");
  assert.equal(state.background, "idle", "the background stays idle under it");
  state = run([{ type: "animation-complete" }], state);
  assert.deepEqual(state, INITIAL_PET_STATE, "the blink settles back to idle");

  // A turn that starts mid-fidget is not lost: the fidget finishes, then the
  // new background takes the stage.
  state = run([
    { type: "one-shot", row: "sleeping" },
    { type: "background", background: "waiting" },
  ]);
  assert.equal(state.row, "sleeping", "a dozing fidget keeps playing");
  assert.equal(state.background, "waiting", "the queued turn is retained");
  state = run([{ type: "animation-complete" }], state);
  assert.equal(state.row, "waiting", "the fidget hands off to the turn");

  // Wander only starts from a fully idle pet, and any activity preempts it.
  state = run([{ type: "wander", direction: "left" }]);
  assert.equal(state.row, "running-left", "an idle pet may wander");
  state = run([{ type: "background", background: "waiting" }], state);
  assert.equal(state.row, "waiting", "activity preempts a wander instantly");
  state = run([{ type: "wander", direction: "right" }], state);
  assert.equal(state.row, "waiting", "a busy pet refuses to wander");
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
  assert.equal(state.row, "review", "wander-stop leaves other rows alone");

  console.log("verify-pet-state-machine: ok");
}

main();
