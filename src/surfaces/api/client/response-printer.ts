import { reconcileSuffix } from "@/surfaces/api/client/turns";
import type { ResponseChunk } from "@/surfaces/api/devices/protocol";

// Renders a streamed response for the chat REPL. It writes text deltas as they
// arrive and, when the turn settles, fills in any tail the live stream missed
// (the pi child can exit before its last deltas flush). Writing goes through an
// injected `write` so the REPL passes process.stdout and tests capture output.
export type ResponsePrinter = {
  // Start a new turn's output. `expectedTurnId` is the id the REPL sent with the
  // turn POST; deltas tagged with any other id are ignored so a straggler from a
  // prior turn cannot print under this one. Omit it to lock onto the first
  // delta's id instead (used when the turn id is not known up front).
  begin(expectedTurnId?: string): void;
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
  // The turn a delta belongs to: the id the REPL expects, or (when none was
  // given) the first delta's id. A delta tagged with any other id is a straggler
  // from a prior turn and is dropped rather than printed under this one.
  let turnId: string | undefined;
  // The next seq expected on this turn's ordered stream. A delta below it is a
  // duplicate; one above it means a delta was lost, so the live preview is
  // abandoned (`broken`) and settle() prints the authoritative final instead.
  let nextSeq = 0;
  let broken = false;

  return {
    begin(expectedTurnId?: string): void {
      active = true;
      streamed = "";
      turnId = expectedTurnId;
      nextSeq = 0;
      broken = false;
    },
    onChunk(chunk: ResponseChunk): void {
      if (!active || broken) return;
      if (turnId === undefined) {
        turnId = chunk.turnId;
      } else if (chunk.turnId !== turnId) {
        return;
      }
      if (chunk.seq < nextSeq) return; // a duplicate already rendered
      if (chunk.seq > nextSeq) {
        // A delta was lost. The live text is now incomplete, so stop previewing
        // and let settle() print the authoritative final in full.
        broken = true;
        return;
      }
      nextSeq = chunk.seq + 1;
      if (chunk.type !== "delta") return;
      if (chunk.channel === "text") {
        streamed += chunk.delta;
        options.write(chunk.delta);
      } else if (options.showThinking) {
        options.write(`${DIM}${chunk.delta}${RESET}`);
      }
    },
    settle(finalText: string): void {
      // A broken stream may have printed a partial line; break before the final
      // so the authoritative text starts clean rather than mid-word.
      if (broken && streamed.length > 0) options.write("\n");
      const suffix = broken ? finalText : reconcileSuffix(streamed, finalText);
      if (suffix) options.write(suffix);
      options.write("\n");
      active = false;
    },
    streamedText(): string {
      return streamed;
    },
  };
}
