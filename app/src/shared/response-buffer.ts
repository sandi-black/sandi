import type { ResponseChunk } from "./protocol-types";

// Accumulates one turn's streamed deltas and reconciles them against the
// authoritative final body when the turn settles. The renderer uses it for the
// live transcript; the main process uses it to persist the reconciled text.
// It mirrors the reference CLI's response printer, minus terminal output.

export type AcceptedDelta = {
  channel: "text" | "thinking";
  delta: string;
};

export type ResponseBufferSnapshot = {
  text: string;
  thinking: string;
  ended: boolean;
};

export type ResponseBuffer = {
  // Returns the delta to display, or null when the chunk is not for this turn,
  // arrives after the stream ended, or replays an already-seen seq.
  accept(chunk: ResponseChunk): AcceptedDelta | null;
  // Returns what still needs appending to the displayed text once the final
  // body arrives (see reconcileSuffix).
  settle(finalText: string): string;
  snapshot(): ResponseBufferSnapshot;
};

export function createResponseBuffer(turnId: string): ResponseBuffer {
  let text = "";
  let thinking = "";
  let ended = false;
  let lastSeq = -1;

  return {
    accept(chunk) {
      if (chunk.turnId !== turnId) return null;
      if (ended) return null;
      // The stream is ordered over one connection; a seq at or below the last
      // seen one is a replayed frame, not new content.
      if (chunk.seq <= lastSeq) return null;
      lastSeq = chunk.seq;
      if (chunk.type === "end") {
        ended = true;
        return null;
      }
      if (chunk.channel === "thinking") {
        thinking += chunk.delta;
      } else {
        text += chunk.delta;
      }
      return { channel: chunk.channel, delta: chunk.delta };
    },
    settle(finalText) {
      ended = true;
      const suffix = reconcileSuffix(text, finalText);
      // Keep the snapshot authoritative too: after settle, `text` is exactly
      // what the transcript should record.
      if (suffix.startsWith("\n") && text.length > 0) {
        text = finalText;
      } else {
        text += suffix;
      }
      return suffix;
    },
    snapshot() {
      return { text, thinking, ended };
    },
  };
}

// Decides what still needs appending once a turn settles, given the text
// already streamed live. A copy of reconcileSuffix in
// src/surfaces/api/client/turns.ts, restated here because this module must be
// importable by the renderer, which cannot reach server source.
// verify-response-buffer.ts asserts the two implementations agree.
//
// - Nothing streamed: the whole final text.
// - Final extends what streamed: only the missing suffix.
// - Streamed already covers the final: nothing.
// - The two diverge: the authoritative final on a fresh line.
export function reconcileSuffix(streamed: string, final: string): string {
  if (streamed.length === 0) return final;
  if (final.startsWith(streamed)) return final.slice(streamed.length);
  if (streamed.startsWith(final)) return "";
  if (streamed.trim() === final.trim()) return "";
  return `\n${final}`;
}
