import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import type { DesktopCredentials } from "@/surfaces/api/client/credentials";
import { executeLocalTool } from "@/surfaces/api/client/executors";
import { postJson } from "@/surfaces/api/client/http";
import type { DesktopFileAttachment } from "@/surfaces/api/devices/desktop-file-transfer";
import {
  type DeviceImage,
  RESPONSE_ATTACHMENT_EVENT,
  RESPONSE_CHUNK_EVENT,
  type ResponseAttachment,
  ResponseAttachmentSchema,
  type ResponseChunk,
  ResponseChunkSchema,
  TOOL_CALL_EVENT,
  TOOL_CANCEL_EVENT,
  ToolCancelSchema,
  ToolDispatchEnvelopeSchema,
  ToolDispatchSchema,
} from "@/surfaces/api/devices/protocol";

// Holds an SSE link to the api surface, runs each dispatched tool call against
// the local machine, and POSTs the result back. Reconnects with backoff so a
// dropped network or a server restart re-establishes the link on its own.

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const LINK_IDLE_TIMEOUT_MS = 75_000;
// Broker calls may carry an 8 MiB write body. Leave room for the dispatch id and
// SSE fields while preventing a peer from growing one unterminated event forever.
const MAX_SSE_EVENT_CHARS = 9 * 1024 * 1024;
const MAX_INFLIGHT_TOOL_CALLS = 8;
const MAX_PENDING_RESULT_POSTS = 256;

export type DesktopClientOptions = {
  credentials: DesktopCredentials;
  // Relative tool paths resolve against this directory.
  rootDir: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  // Called for each streamed response delta the server pushes during a turn.
  // The hands-only `run` command omits it (deltas are ignored); the `chat` REPL
  // supplies it to print the answer as it arrives.
  onResponseChunk?: (chunk: ResponseChunk) => void;
  // Called for each outbound attachment notice the server pushes during a turn
  // (the attach_to_reply extension tool reporting a file Sandi wrote to this
  // desktop). Optional for the same reason as onResponseChunk: the hands-only
  // `run` command has no reply stream to attach anything to.
  onResponseAttachment?: (attachment: ResponseAttachment) => void;
};

// Runtime seams keep transport limits deterministic in verification without
// weakening production defaults or adding multi-second waits to the checks.
export type DesktopClientRuntime = {
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSseEventChars?: number;
  maxInflightToolCalls?: number;
  maxPendingResultPosts?: number;
  reconnectDelay?: (attempt: number) => number;
};

type ResolvedDesktopClientRuntime = {
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
  maxSseEventChars: number;
  maxInflightToolCalls: number;
  maxPendingResultPosts: number;
  reconnectDelay: (attempt: number) => number;
};

// One live SSE link. `signal` aborts when the link settles (so in-flight tool
// calls are cancelled with it); `inflight` maps a dispatch id to the controller
// for its running call so a `tool_cancel` event can stop just that one.
type Connection = {
  options: DesktopClientOptions;
  signal: AbortSignal;
  inflight: Map<string, AbortController>;
  maxInflightToolCalls: number;
  resultPosts: ResultPostGate;
};

type ResultPostGate = {
  active: number;
  limit: number;
  pendingLimit: number;
  waiters: ResultPostWaiter[];
};

type ResultPostPermit = () => void;

type ResultPostWaiter = {
  signal: AbortSignal;
  state: "waiting" | "settled";
  resolve: (permit: ResultPostPermit | undefined) => void;
  onAbort: () => void;
};

export async function runDesktopClient(
  options: DesktopClientOptions,
  runtimeOptions: DesktopClientRuntime = {},
): Promise<void> {
  const runtime = resolveRuntime(runtimeOptions);
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      await connectOnce(options, runtime, () => {
        // Reaching a valid event stream proves the route is healthy. A later
        // reset starts from the base delay even if startup needed many retries.
        attempt = 0;
      });
      // A clean end (server closed the stream): reconnect promptly.
      attempt = 0;
    } catch (error) {
      options.onStatus?.(`link dropped: ${errorMessage(error)}`);
    }
    if (options.signal?.aborted) break;
    await sleep(runtime.reconnectDelay(attempt), options.signal);
    attempt += 1;
  }
}

function connectOnce(
  options: DesktopClientOptions,
  runtime: ResolvedDesktopClientRuntime,
  onLinked: () => void,
): Promise<void> {
  return new Promise((resolveConn, rejectConn) => {
    let target: URL;
    try {
      target = new URL("/v1/devices/link", options.credentials.url);
    } catch (error) {
      rejectConn(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Scoped to this one connection: aborted whenever the link settles so any
    // tool calls still running on this connection are cancelled, never left to
    // post a result back over a link that has gone away.
    const connection = new AbortController();
    const onParentAbort = (): void => connection.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    let settled = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHandshakeTimer = (): void => {
      if (!handshakeTimer) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    };
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearHandshakeTimer();
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onParentAbort);
      connection.abort();
      run();
    };
    const conn: Connection = {
      options,
      signal: connection.signal,
      inflight: new Map(),
      maxInflightToolCalls: runtime.maxInflightToolCalls,
      resultPosts: {
        active: 0,
        limit: runtime.maxInflightToolCalls,
        pendingLimit: runtime.maxPendingResultPosts,
        waiters: [],
      },
    };
    const parser = createSseParser(runtime.maxSseEventChars);
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(
          `device link was idle for ${runtime.idleTimeoutMs}ms`,
        );
        settle(() => rejectConn(error));
        req.destroy(error);
      }, runtime.idleTimeoutMs);
    };

    const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      target,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.credentials.token}`,
          accept: "text/event-stream",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          settle(() =>
            rejectConn(
              new Error(`device link returned status ${res.statusCode}`),
            ),
          );
          return;
        }
        if (!isEventStreamContentType(res.headers["content-type"])) {
          res.resume();
          settle(() =>
            rejectConn(
              new Error("device link did not return text/event-stream"),
            ),
          );
          return;
        }
        clearHandshakeTimer();
        onLinked();
        options.onStatus?.("linked");
        armIdleTimer();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          armIdleTimer();
          const parsed = parser.push(chunk);
          if (!parsed.ok) {
            settle(() => rejectConn(parsed.error));
            res.destroy(parsed.error);
            return;
          }
          for (const block of parsed.blocks) {
            handleEvent(block, conn);
          }
        });
        res.on("end", () => settle(() => resolveConn()));
        res.on("error", (error) => settle(() => rejectConn(error)));
      },
    );
    handshakeTimer = setTimeout(() => {
      const error = new Error(
        `device link handshake timed out after ${runtime.handshakeTimeoutMs}ms`,
      );
      settle(() => rejectConn(error));
      req.destroy(error);
    }, runtime.handshakeTimeoutMs);
    req.on("error", (error) => settle(() => rejectConn(error)));
    connection.signal.addEventListener(
      "abort",
      () => {
        req.destroy();
        settle(() => resolveConn());
      },
      { once: true },
    );
    req.end();
  });
}

function handleEvent(block: string, conn: Connection): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment line / heartbeat
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");

  if (event === TOOL_CANCEL_EVENT) {
    handleCancel(data, conn);
    return;
  }
  if (event === RESPONSE_CHUNK_EVENT) {
    handleResponseChunk(data, conn);
    return;
  }
  if (event === RESPONSE_ATTACHMENT_EVENT) {
    handleResponseAttachment(data, conn);
    return;
  }
  if (event !== TOOL_CALL_EVENT) return;
  // Run each call without blocking the read loop so the desktop can handle
  // several at once. The catch is a backstop: runToolCall already reports tool
  // failures, so reaching here means an unexpected internal error, not a tool
  // result, and must not become an unhandled rejection.
  runToolCall(data, conn).catch((error: unknown) => {
    conn.options.onStatus?.(`tool dispatch error: ${errorMessage(error)}`);
  });
}

// A malformed event on the link is a protocol failure, not nothing. Surfacing
// it through onStatus keeps a corrupt frame from vanishing without a trace,
// which matters most for attachments (they have no later reconciliation the
// way streamed chunks do, so a dropped one is simply lost).
function surfaceDroppedEvent(conn: Connection, event: string): void {
  conn.options.onStatus?.(`dropped a malformed ${event} event`);
}

// Shared body of handleResponseChunk and handleResponseAttachment: both bail
// when nobody is listening, then parse and validate the event's JSON payload
// before handing it to the caller, dropping (with a surfaced status message)
// anything that fails either step. The two differ only in which callback they
// feed and which schema validates the payload.
function handleParsedEvent<T>(
  data: string,
  event: string,
  schema: z.ZodType<T>,
  callback: ((value: T) => void) | undefined,
  conn: Connection,
): void {
  if (!callback) return;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    surfaceDroppedEvent(conn, event);
    return;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    surfaceDroppedEvent(conn, event);
    return;
  }
  callback(parsed.data);
}

function handleResponseChunk(data: string, conn: Connection): void {
  handleParsedEvent(
    data,
    RESPONSE_CHUNK_EVENT,
    ResponseChunkSchema,
    conn.options.onResponseChunk,
    conn,
  );
}

function handleResponseAttachment(data: string, conn: Connection): void {
  handleParsedEvent(
    data,
    RESPONSE_ATTACHMENT_EVENT,
    ResponseAttachmentSchema,
    conn.options.onResponseAttachment,
    conn,
  );
}

function handleCancel(data: string, conn: Connection): void {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return;
  }
  const parsed = ToolCancelSchema.safeParse(raw);
  if (!parsed.success) return;
  // The dispatch event is fully processed before the next event block, so a
  // call's controller is already registered by the time its cancel arrives.
  conn.inflight.get(parsed.data.id)?.abort();
}

async function runToolCall(data: string, conn: Connection): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return; // unparseable dispatch: no id to answer, so nothing to report
  }
  // Read the id first (from its own schema) so even a call whose tool or params
  // fail validation can be answered against the right id. Then parse the whole
  // dispatch as the precise discriminated union, so the executor runs typed
  // params rather than fields reached out of raw JSON.
  const envelope = ToolDispatchEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return; // no usable id, so nothing to report
  const id = envelope.data.id;

  // Treat every replay of an active id as a duplicate before considering the
  // rest of its payload. A malformed replay must not post an "invalid" result
  // that could settle the legitimate call sharing that id.
  if (conn.inflight.has(id)) {
    conn.options.onStatus?.(`dropped duplicate active tool call id ${id}`);
    return;
  }

  const dispatch = ToolDispatchSchema.safeParse(raw);
  if (!dispatch.success) {
    await reportResult(conn, {
      id,
      ok: false,
      output: "",
      error: "invalid tool call",
    });
    return;
  }

  if (conn.inflight.size >= conn.maxInflightToolCalls) {
    await reportResult(conn, {
      id,
      ok: false,
      output: "",
      error: `too many tool calls in flight (limit ${conn.maxInflightToolCalls})`,
    });
    return;
  }

  // The call aborts when its turn is cancelled (a tool_cancel event aborts this
  // controller) or when the whole link settles (the connection signal). Register
  // before the first await so a cancel arriving next is never missed.
  const call = new AbortController();
  const signal = AbortSignal.any([conn.signal, call.signal]);
  conn.inflight.set(id, call);
  try {
    // dispatch.data is `{ id } & BrokerCall`, so it carries the validated tool
    // and typed params straight into the executor; no re-parsing downstream.
    const outcome = await executeLocalTool(
      dispatch.data,
      { rootDir: conn.options.rootDir },
      signal,
    );
    if (signal.aborted) return;
    await reportResult(
      conn,
      {
        id,
        ok: outcome.ok,
        output: outcome.output,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.image !== undefined ? { image: outcome.image } : {}),
        ...(outcome.attachment !== undefined
          ? { attachment: outcome.attachment }
          : {}),
      },
      signal,
    );
  } finally {
    conn.inflight.delete(id);
  }
}

async function reportResult(
  conn: Connection,
  result: {
    id: string;
    ok: boolean;
    output: string;
    error?: string;
    image?: DeviceImage;
    attachment?: DesktopFileAttachment;
  },
  signal: AbortSignal = conn.signal,
): Promise<void> {
  // Invalid and over-cap dispatches never enter `inflight`, yet their refusal
  // results use the same HTTP endpoint as completed tools. Gate every result so
  // hostile SSE input cannot bypass the tool limit by spawning rejection POSTs.
  const permit = await acquireResultPostPermit(conn.resultPosts, signal);
  if (!permit) {
    if (!signal.aborted) {
      conn.options.onStatus?.(
        "dropped a tool result because its queue is full",
      );
    }
    return;
  }
  try {
    const response = await postJson({
      url: conn.options.credentials.url,
      path: "/v1/devices/result",
      token: conn.options.credentials.token,
      body: result,
      // A settled link aborts a result POST that would otherwise hang and pin
      // this call's inflight entry. The server's own backstop has already freed
      // the pending call by then, so the result is moot.
      signal,
    });
    // postJson resolves for any status, so a rejected result (auth lost, the
    // call already freed, a server error) would otherwise pass silently. Surface
    // it: the turn falls back on the server's backstop rather than a phantom
    // accepted result.
    if (response.status < 200 || response.status >= 300) {
      conn.options.onStatus?.(
        `server rejected a tool result with status ${response.status}`,
      );
    }
  } catch (error) {
    // The broker's abort and backstop free a call whose result never lands, so a
    // failed POST degrades to a tool error on the server rather than a hang.
    conn.options.onStatus?.(
      `failed to report a tool result: ${errorMessage(error)}`,
    );
  } finally {
    permit();
  }
}

function acquireResultPostPermit(
  gate: ResultPostGate,
  signal: AbortSignal,
): Promise<ResultPostPermit | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  if (gate.active < gate.limit) {
    gate.active += 1;
    return Promise.resolve(createResultPostPermit(gate));
  }
  if (gate.waiters.length >= gate.pendingLimit) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const waiter: ResultPostWaiter = {
      signal,
      state: "waiting",
      resolve,
      onAbort: () => {
        if (waiter.state !== "waiting") return;
        waiter.state = "settled";
        const index = gate.waiters.indexOf(waiter);
        if (index !== -1) gate.waiters.splice(index, 1);
        resolve(undefined);
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    gate.waiters.push(waiter);
  });
}

function createResultPostPermit(gate: ResultPostGate): ResultPostPermit {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.active -= 1;

    for (;;) {
      const waiter = gate.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.state !== "waiting" || waiter.signal.aborted) {
        if (waiter.state === "waiting") {
          waiter.state = "settled";
          waiter.resolve(undefined);
        }
        continue;
      }
      waiter.state = "settled";
      gate.active += 1;
      waiter.resolve(createResultPostPermit(gate));
      return;
    }
  };
}

type SseParseResult =
  | { ok: true; blocks: string[] }
  | { ok: false; error: Error };

function createSseParser(maxEventChars: number): {
  push(chunk: string): SseParseResult;
} {
  let buffer = "";
  return {
    push(chunk: string): SseParseResult {
      buffer += chunk;
      const blocks: string[] = [];
      for (;;) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        if (boundary.index > maxEventChars) {
          return {
            ok: false,
            error: new Error(
              `device link SSE event exceeded ${maxEventChars} characters`,
            ),
          };
        }
        blocks.push(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
      }
      if (buffer.length > maxEventChars) {
        return {
          ok: false,
          error: new Error(
            `device link SSE event exceeded ${maxEventChars} characters`,
          ),
        };
      }
      return { ok: true, blocks };
    },
  };
}

function findSseBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) {
    return { index: lf, length: 2 };
  }
  return { index: crlf, length: 4 };
}

function isEventStreamContentType(
  value: string | string[] | undefined,
): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (item) =>
      item?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream",
  );
}

function resolveRuntime(
  options: DesktopClientRuntime,
): ResolvedDesktopClientRuntime {
  return {
    handshakeTimeoutMs: positiveInteger(
      options.handshakeTimeoutMs,
      HANDSHAKE_TIMEOUT_MS,
    ),
    idleTimeoutMs: positiveInteger(options.idleTimeoutMs, LINK_IDLE_TIMEOUT_MS),
    maxSseEventChars: positiveInteger(
      options.maxSseEventChars,
      MAX_SSE_EVENT_CHARS,
    ),
    maxInflightToolCalls: positiveInteger(
      options.maxInflightToolCalls,
      MAX_INFLIGHT_TOOL_CALLS,
    ),
    maxPendingResultPosts: positiveInteger(
      options.maxPendingResultPosts,
      MAX_PENDING_RESULT_POSTS,
    ),
    reconnectDelay: options.reconnectDelay ?? desktopReconnectDelay,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function desktopReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const normalizedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  const ceiling = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(normalizedAttempt, 30),
  );
  const rawSample = random();
  const sample = Number.isFinite(rawSample)
    ? Math.min(1, Math.max(0, rawSample))
    : 0.5;
  return Math.round(ceiling * (0.5 + sample / 2));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
