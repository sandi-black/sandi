import { reconcileSuffix } from "@/surfaces/api/client/turns";
import type { ResponseChunk } from "@/surfaces/api/devices/protocol";

// Renders a streamed response for the chat REPL. It writes text deltas as they
// arrive and, when the turn settles, fills in any tail the live stream missed
// (the pi child can exit before its last deltas flush). Writing goes through an
// injected `write` so the REPL passes process.stdout and tests capture output.
export type ResponsePrinter = {
  // Start a new turn's output. Resets the per-turn stream state.
  begin(): void;
  // Handle one streamed delta from the device link.
  onChunk(chunk: ResponseChunk): void;
  // Reconcile against the authoritative final text and end the line.
  settle(finalText: string): void;
  // The visible text streamed so far this turn (exposed for tests).
  streamedText(): string;
};

const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

export function createResponsePrinter(options: {
  write: (text: string) => void;
  // Render the model's thinking (dimmed) alongside the answer. Off by default so
  // the visible answer stays clean.
  showThinking?: boolean;
}): ResponsePrinter {
  let active = false;
  let streamed = "";
  // The turn a delta belongs to. Locked to the first delta seen this turn so a
  // late straggler from a prior turn (a different id) is ignored rather than
  // bleeding into the current answer.
  let turnId: string | undefined;

  return {
    begin(): void {
      active = true;
      streamed = "";
      turnId = undefined;
    },
    onChunk(chunk: ResponseChunk): void {
      if (!active) return;
      if (turnId === undefined) {
        turnId = chunk.turnId;
      } else if (chunk.turnId !== turnId) {
        return;
      }
      if (chunk.type !== "delta") return;
      if (chunk.channel === "text") {
        streamed += chunk.delta;
        options.write(chunk.delta);
      } else if (options.showThinking) {
        options.write(`${DIM}${chunk.delta}${RESET}`);
      }
    },
    settle(finalText: string): void {
      const suffix = reconcileSuffix(streamed, finalText);
      if (suffix) options.write(suffix);
      options.write("\n");
      active = false;
    },
    streamedText(): string {
      return streamed;
    },
  };
}
