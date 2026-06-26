import { request as httpRequest } from "node:http";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Phase 3: streams the assistant's response back to the human's desktop as it is
// generated. An api-surface turn runs server-side; this extension, loaded into
// the pi child, subscribes to the model's streaming events and POSTs each text
// delta to the same per-turn loopback broker the hands-local tools use. The
// broker relays each delta to the paired desktop over its SSE link, so the
// desktop sees the answer appear token by token instead of waiting for the turn
// to finish.
//
// Like local-exec-tools.ts, this file is loaded directly by the pi CLI, which
// does not honor the tsconfig path alias. So it imports nothing from `@/` and
// re-states the broker env-var names and the response-chunk wire shape that
// src/surfaces/api/devices/protocol.ts owns. The two are the ends of one JSON
// contract.

const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";
const TURN_ID_ENV = "SANDI_TURN_ID";

// A streamed delta is tiny and the broker relays it without awaiting a desktop
// reply, so a slow POST means the link is wedged, not busy. Cap it short so a
// stalled send cannot pile up behind the model's generation.
const CALL_TIMEOUT_MS = 10_000;

export type StreamTarget = {
  url: string;
  token: string;
  turnId: string;
};

export default function responseStreamExtension(pi: ExtensionAPI): void {
  const target = readStreamTarget();
  if (!target) {
    // No broker or turn id on this child (not a hands-local streaming turn, or
    // no desktop is paired). Subscribe to nothing: the turn still runs and its
    // final response returns over the turn's HTTP body as before.
    return;
  }

  const relay = createChunkRelay(target);
  pi.on("message_update", (event) => {
    const chunk = intentToChunk(
      classifyAssistantEvent(event.assistantMessageEvent),
    );
    if (chunk) relay.relay(chunk);
  });
}

export type OutChunk =
  | { type: "delta"; channel: "text" | "thinking"; delta: string }
  | { type: "end" };

// Maps a classified streaming intent to the chunk to relay, or undefined when
// the intent carries nothing to send (a tool-call delta, a content-block marker,
// an unrecognized event). The turnId and seq are added by the relay, so this
// stays a pure shape conversion the tests can check in isolation.
export function intentToChunk(
  intent: AssistantStreamIntent,
): OutChunk | undefined {
  if (intent.kind === "text") {
    return { type: "delta", channel: "text", delta: intent.delta };
  }
  if (intent.kind === "thinking") {
    return { type: "delta", channel: "thinking", delta: intent.delta };
  }
  if (intent.kind === "end") {
    return { type: "end" };
  }
  return undefined;
}

export type ChunkRelay = {
  // Queue one chunk for the broker. Stamps it with the target's turnId and the
  // next seq (assigned synchronously so order is fixed at call time), then sends
  // it after any prior chunk. A no-op once the stream has stopped.
  relay(partial: OutChunk): void;
  // Resolves once every queued send has settled (exposed for tests).
  drain(): Promise<void>;
  // True once a send returned a non-202 status or threw, so the stream is done.
  readonly stopped: boolean;
};

// Builds the serialized relay behind the extension. Sends run one at a time in
// generation order so deltas reach the broker without blocking pi's event loop
// on the network, and the first non-202 (desktop gone, token revoked, turn
// mismatch) or transport error stops the stream rather than hammering a dead
// channel. The `post` seam lets tests drive the status without a real broker.
export function createChunkRelay(
  target: StreamTarget,
  post: (target: StreamTarget, chunk: unknown) => Promise<number> = postChunk,
): ChunkRelay {
  let seq = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  return {
    relay(partial: OutChunk): void {
      if (stopped) return;
      const chunk = { ...partial, turnId: target.turnId, seq: seq++ };
      chain = chain.then(async () => {
        if (stopped) return;
        try {
          const status = await post(target, chunk);
          // Anything but 202 is terminal for this turn's stream. Stop pushing;
          // the turn's final HTTP body still carries the complete answer.
          if (status !== 202) stopped = true;
        } catch {
          // A transport error is terminal too. A lost stream costs only the live
          // preview, never the turn (the final body is authoritative).
          stopped = true;
        }
      });
    },
    drain(): Promise<void> {
      return chain;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}

// The streaming intents this extension acts on, distilled from pi's assistant
// message events. Everything else (tool-call deltas, start/end markers for
// content blocks) maps to "ignore": it is not part of the visible answer stream.
export type AssistantStreamIntent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "end" }
  | { kind: "ignore" };

// Classifies one of pi's assistant message events (the `assistantMessageEvent`
// on a `message_update`) into a streaming intent. Takes `unknown` and validates
// defensively: pi's event is third-party JSON-shaped data crossing into this
// extension, so a shape we do not recognize is ignored rather than trusted. A
// `done` event ends the stream only when the model stopped on its own ("stop")
// or hit the length cap ("length"); a "toolUse" stop means more text follows
// after the tools run, so it is not the end of the response.
export function classifyAssistantEvent(event: unknown): AssistantStreamIntent {
  if (typeof event !== "object" || event === null) return { kind: "ignore" };
  const record: Record<string, unknown> = { ...event };
  const type = record["type"];
  if (type === "text_delta") {
    const delta = record["delta"];
    if (typeof delta === "string") return { kind: "text", delta };
  } else if (type === "thinking_delta") {
    const delta = record["delta"];
    if (typeof delta === "string") return { kind: "thinking", delta };
  } else if (type === "done") {
    const reason = record["reason"];
    if (reason === "stop" || reason === "length") return { kind: "end" };
  }
  return { kind: "ignore" };
}

// Exported for tests: reads and validates the per-turn streaming target the api
// surface set on this child, or undefined when streaming is not wired (no broker
// leased, no turn id, or a malformed value). Mirrors the broker validation in
// local-exec-tools.ts: loopback http on 127.0.0.1 and a 64-char hex token, so a
// tampered env disables streaming up front rather than failing on the first POST.
export function readStreamTarget(): StreamTarget | undefined {
  const rawUrl = process.env[TOOL_BROKER_URL_ENV]?.trim();
  const rawToken = process.env[TOOL_BROKER_TOKEN_ENV]?.trim();
  const turnId = process.env[TURN_ID_ENV]?.trim();
  if (!rawUrl || !rawToken || !turnId) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.hostname !== "127.0.0.1") return undefined;
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return undefined;
  return { url: parsed.origin, token: rawToken, turnId };
}

// Exported for tests: POSTs one response chunk to the broker's streaming ingress
// and resolves with the HTTP status. The caller treats 503 as "stop streaming"
// (the desktop is gone) and swallows everything else, since a lost delta does
// not fail the turn.
export function postChunk(
  target: StreamTarget,
  chunk: unknown,
): Promise<number> {
  return new Promise((resolvePost, rejectPost) => {
    let url: URL;
    try {
      url = new URL("/stream", target.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const payload = Buffer.from(JSON.stringify(chunk), "utf8");
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": payload.length,
          authorization: `Bearer ${target.token}`,
        },
      },
      (res) => {
        // The body carries no information the streamer needs; drain it so the
        // socket can be reused and the response can end.
        res.resume();
        res.on("end", () => resolvePost(res.statusCode ?? 0));
      },
    );
    req.setTimeout(CALL_TIMEOUT_MS, () => {
      req.destroy(new Error("response stream POST timed out"));
    });
    req.on("error", (error) => rejectPost(error));
    req.end(payload);
  });
}
