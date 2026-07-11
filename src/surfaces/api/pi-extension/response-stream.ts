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
const STREAM_MAX_BODY_BYTES = 1 * 1024 * 1024;
const STATUS_RESPONSE_MAX_BYTES = 64 * 1024;
// Keep at most a modest live-preview backlog while one POST is stalled. The
// completed turn body is authoritative, so stopping the preview is safer than
// retaining an unbounded promise chain for model token deltas.
const MAX_PENDING_CHUNKS = 32;
const MAX_PENDING_DELTA_BYTES = 256 * 1024;

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
      classifyAssistantEvent(readAssistantMessageEvent(event)),
    );
    if (chunk) relay.relay(chunk);
  });
}

// Reads the `assistantMessageEvent` field out of pi's message_update payload,
// returning it as unknown for the classifier, or undefined when the payload is
// not the shape we expect. pi's event is third-party JSON-shaped data crossing
// into this extension, so it is narrowed at the boundary rather than reached into
// directly. The classifier validates the inner event in turn.
export function readAssistantMessageEvent(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  const record: Record<string, unknown> = { ...event };
  return record["assistantMessageEvent"];
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
  // Queue one chunk for the broker. Adjacent pending deltas on the same channel
  // are coalesced, then stamped with the target's turnId and the next seq when
  // sent. A no-op once the stream has stopped.
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
  let running = false;
  let pendingBytes = 0;
  const pending: OutChunk[] = [];
  let idlePromise: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | undefined;

  const finish = (): void => {
    running = false;
    const resolve = resolveIdle;
    resolveIdle = undefined;
    resolve?.();
  };

  const pump = async (): Promise<void> => {
    while (!stopped) {
      const partial = pending.shift();
      if (!partial) break;
      pendingBytes -= chunkBytes(partial);
      const chunk = { ...partial, turnId: target.turnId, seq: seq++ };
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
    }
    if (stopped) {
      pending.length = 0;
      pendingBytes = 0;
    }
    finish();
  };

  const start = (): void => {
    if (running) return;
    running = true;
    idlePromise = new Promise((resolve) => {
      resolveIdle = resolve;
    });
    void pump();
  };

  return {
    relay(partial: OutChunk): void {
      if (stopped) return;
      const bytes = chunkBytes(partial);
      if (bytes > MAX_PENDING_DELTA_BYTES) {
        stopped = true;
        pending.length = 0;
        pendingBytes = 0;
        return;
      }

      const last = pending.at(-1);
      if (
        partial.type === "delta" &&
        last?.type === "delta" &&
        last.channel === partial.channel &&
        pendingBytes + bytes <= MAX_PENDING_DELTA_BYTES
      ) {
        last.delta += partial.delta;
        pendingBytes += bytes;
      } else {
        if (
          pending.length >= MAX_PENDING_CHUNKS ||
          pendingBytes + bytes > MAX_PENDING_DELTA_BYTES
        ) {
          stopped = true;
          pending.length = 0;
          pendingBytes = 0;
          return;
        }
        pending.push({ ...partial });
        pendingBytes += bytes;
      }
      start();
    },
    drain(): Promise<void> {
      return idlePromise;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}

function chunkBytes(chunk: OutChunk): number {
  return chunk.type === "delta" ? Buffer.byteLength(chunk.delta, "utf8") : 0;
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
    if (payload.length > STREAM_MAX_BODY_BYTES) {
      rejectPost(new Error("response stream POST exceeded 1 MiB"));
      return;
    }
    let settled = false;
    let responseStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      run();
    };
    const rejectOnce = (error: unknown): void => {
      settle(() =>
        rejectPost(error instanceof Error ? error : new Error(String(error))),
      );
    };
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
        responseStarted = true;
        let received = 0;
        let ended = false;
        const declaredLength = parseContentLength(
          res.headers["content-length"],
        );
        if (
          declaredLength !== undefined &&
          declaredLength > STATUS_RESPONSE_MAX_BYTES
        ) {
          const error = new Error(
            "response stream broker reply exceeded 64 KiB",
          );
          rejectOnce(error);
          res.destroy();
          req.destroy();
          return;
        }
        res.on("data", (data: Buffer) => {
          received += data.length;
          if (received > STATUS_RESPONSE_MAX_BYTES) {
            const error = new Error(
              "response stream broker reply exceeded 64 KiB",
            );
            rejectOnce(error);
            res.destroy(error);
            req.destroy(error);
          }
        });
        res.on("aborted", () => {
          rejectOnce(
            new Error("response stream broker reply aborted before completion"),
          );
        });
        res.on("error", rejectOnce);
        res.on("end", () => {
          ended = true;
          const status = res.statusCode ?? 0;
          settle(() => resolvePost(status));
        });
        res.on("close", () => {
          if (!ended) {
            rejectOnce(
              new Error(
                "response stream broker reply closed before completion",
              ),
            );
          }
        });
      },
    );
    timer = setTimeout(() => {
      const error = new Error("response stream POST timed out");
      rejectOnce(error);
      req.destroy(error);
    }, CALL_TIMEOUT_MS);
    req.on("error", rejectOnce);
    req.on("close", () => {
      if (!settled && !responseStarted) {
        rejectOnce(
          new Error("response stream broker closed before a response"),
        );
      }
    });
    try {
      req.end(payload);
    } catch (error) {
      rejectOnce(error);
      req.destroy();
    }
  });
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}
