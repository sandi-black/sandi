import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { DesktopCredentials } from "@/surfaces/api/client/credentials";
import { executeLocalTool } from "@/surfaces/api/client/executors";
import { postJson } from "@/surfaces/api/client/http";
import {
  LocalToolNameSchema,
  TOOL_CALL_EVENT,
  TOOL_CANCEL_EVENT,
  ToolCancelSchema,
} from "@/surfaces/api/devices/protocol";

// Holds an SSE link to the api surface, runs each dispatched tool call against
// the local machine, and POSTs the result back. Reconnects with backoff so a
// dropped network or a server restart re-establishes the link on its own.

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type DesktopClientOptions = {
  credentials: DesktopCredentials;
  // Relative tool paths resolve against this directory.
  rootDir: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
};

// One live SSE link. `signal` aborts when the link settles (so in-flight tool
// calls are cancelled with it); `inflight` maps a dispatch id to the controller
// for its running call so a `tool_cancel` event can stop just that one.
type Connection = {
  options: DesktopClientOptions;
  signal: AbortSignal;
  inflight: Map<string, AbortController>;
};

export async function runDesktopClient(
  options: DesktopClientOptions,
): Promise<void> {
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      await connectOnce(options);
      // A clean end (server closed the stream): reconnect promptly.
      attempt = 0;
    } catch (error) {
      options.onStatus?.(
        `link dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (options.signal?.aborted) break;
    await sleep(backoff(attempt), options.signal);
    attempt += 1;
  }
}

function connectOnce(options: DesktopClientOptions): Promise<void> {
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
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onParentAbort);
      connection.abort();
      run();
    };
    const conn: Connection = {
      options,
      signal: connection.signal,
      inflight: new Map(),
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
        options.onStatus?.("linked");
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            handleEvent(block, conn);
            boundary = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => settle(() => resolveConn()));
        res.on("error", (error) => settle(() => rejectConn(error)));
      },
    );
    req.on("error", (error) => settle(() => rejectConn(error)));
    connection.signal.addEventListener("abort", () => req.destroy(), {
      once: true,
    });
    req.end();
  });
}

function handleEvent(block: string, conn: Connection): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
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
  if (event !== TOOL_CALL_EVENT) return;
  // Run each call without blocking the read loop so the desktop can handle
  // several at once. The catch is a backstop: runToolCall already reports tool
  // failures, so reaching here means an unexpected internal error, not a tool
  // result, and must not become an unhandled rejection.
  runToolCall(data, conn).catch((error: unknown) => {
    conn.options.onStatus?.(
      `tool dispatch error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
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
  if (typeof raw !== "object" || raw === null) return;
  const record: Record<string, unknown> = { ...raw };
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) return;

  const toolParse = LocalToolNameSchema.safeParse(record["tool"]);
  if (!toolParse.success) {
    await reportResult(conn, {
      id,
      ok: false,
      output: "",
      error: "unknown tool",
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
    const outcome = await executeLocalTool(
      toolParse.data,
      record["params"],
      { rootDir: conn.options.rootDir },
      signal,
    );
    await reportResult(conn, {
      id,
      ok: outcome.ok,
      output: outcome.output,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
  } finally {
    conn.inflight.delete(id);
  }
}

async function reportResult(
  conn: Connection,
  result: { id: string; ok: boolean; output: string; error?: string },
): Promise<void> {
  try {
    await postJson({
      url: conn.options.credentials.url,
      path: "/v1/devices/result",
      token: conn.options.credentials.token,
      body: result,
      // A settled link aborts a result POST that would otherwise hang and pin
      // this call's inflight entry. The server's own backstop has already freed
      // the pending call by then, so the result is moot.
      signal: conn.signal,
    });
  } catch (error) {
    // The broker's abort and backstop free a call whose result never lands, so a
    // failed POST degrades to a tool error on the server rather than a hang.
    conn.options.onStatus?.(
      `failed to report a tool result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function backoff(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
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
