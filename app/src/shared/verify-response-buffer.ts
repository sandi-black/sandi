import assert from "node:assert/strict";

import type { ResponseChunk } from "./protocol-types";
import { createResponseBuffer, reconcileSuffix } from "./response-buffer";
import { reconcileSuffix as serverReconcileSuffix } from "@sandi-server/surfaces/api/client/turns";
import type { ResponseChunk as ServerResponseChunk } from "@sandi-server/surfaces/api/devices/protocol";

// Exercises the streaming buffer against ordered, duplicated, gapped, and
// foreign chunks, and pins this module's reconcile copy (plus the mirrored
// wire types) to the server originals. Run with:
// npm run verify:response-buffer -w app

// Mutual assignability between the mirrored ResponseChunk and the server's
// zod-inferred type; if protocol.ts changes shape, one of these stops
// compiling.
function acceptMirrored(chunk: ResponseChunk): ServerResponseChunk {
  return chunk;
}
function acceptServer(chunk: ServerResponseChunk): ResponseChunk {
  return chunk;
}

function delta(
  turnId: string,
  seq: number,
  text: string,
  channel: "text" | "thinking" = "text",
): ResponseChunk {
  return { type: "delta", turnId, seq, channel, delta: text };
}

function main(): void {
  // Keep the type-level pins referenced so the compiler cannot drop them.
  assert.equal(typeof acceptMirrored, "function");
  assert.equal(typeof acceptServer, "function");

  // The reconcile copy must agree with the server implementation everywhere,
  // including the divergence fallback.
  const cases: [string, string][] = [
    ["", "full answer"],
    ["par", "partial answer"],
    ["partial answer", "partial answer"],
    ["ran ahead of the final", "ran ahead"],
    ["matches modulo whitespace", "matches modulo whitespace\n"],
    ["these two", "diverged completely"],
  ];
  for (const [streamed, final] of cases) {
    assert.equal(
      reconcileSuffix(streamed, final),
      serverReconcileSuffix(streamed, final),
      `reconcile agrees for (${JSON.stringify(streamed)}, ${JSON.stringify(final)})`,
    );
  }

  // Ordered accumulation across both channels.
  let buffer = createResponseBuffer("turn-1");
  assert.deepEqual(
    buffer.accept(delta("turn-1", 0, "thinking...", "thinking")),
    {
      channel: "thinking",
      delta: "thinking...",
    },
  );
  assert.deepEqual(buffer.accept(delta("turn-1", 1, "Hello")), {
    channel: "text",
    delta: "Hello",
  });
  assert.deepEqual(buffer.accept(delta("turn-1", 2, ", Ada")), {
    channel: "text",
    delta: ", Ada",
  });
  assert.deepEqual(buffer.snapshot(), {
    text: "Hello, Ada",
    thinking: "thinking...",
    ended: false,
  });

  // Foreign turns and replayed seqs are dropped without touching the state.
  assert.equal(buffer.accept(delta("turn-9", 3, "x")), null, "foreign turn");
  assert.equal(buffer.accept(delta("turn-1", 2, "dup")), null, "replayed seq");
  assert.equal(buffer.snapshot().text, "Hello, Ada");

  // A gap is accepted (content already lost upstream); settle fills the tail.
  assert.deepEqual(buffer.accept(delta("turn-1", 7, "!")), {
    channel: "text",
    delta: "!",
  });
  assert.equal(buffer.settle("Hello, Ada! Welcome back."), " Welcome back.");
  assert.deepEqual(buffer.snapshot(), {
    text: "Hello, Ada! Welcome back.",
    thinking: "thinking...",
    ended: true,
  });
  assert.equal(buffer.accept(delta("turn-1", 8, "late")), null, "post-settle");

  // An end chunk closes the stream: later deltas are dropped, and settle still
  // reconciles.
  buffer = createResponseBuffer("turn-2");
  buffer.accept(delta("turn-2", 0, "The answer"));
  assert.equal(buffer.accept({ type: "end", turnId: "turn-2", seq: 1 }), null);
  assert.equal(buffer.accept(delta("turn-2", 2, " keeps going")), null);
  assert.equal(buffer.settle("The answer is 42."), " is 42.");

  // Divergence: settle falls back to the authoritative final, and the
  // snapshot records exactly the final text (not the bad preview plus a
  // correction).
  buffer = createResponseBuffer("turn-3");
  buffer.accept(delta("turn-3", 0, "wrong preview"));
  assert.equal(buffer.settle("the real answer"), "\nthe real answer");
  assert.equal(buffer.snapshot().text, "the real answer");

  // Nothing streamed at all: the final body is everything.
  buffer = createResponseBuffer("turn-4");
  assert.equal(buffer.settle("entire reply"), "entire reply");
  assert.equal(buffer.snapshot().text, "entire reply");

  console.log("verify-response-buffer: ok");
}

main();
