import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { DesktopCredentials } from "@/surfaces/api/client/credentials";
import { executeLocalTool } from "@/surfaces/api/client/executors";
import { postJson } from "@/surfaces/api/client/http";
import {
  LocalToolNameSchema,
  TOOL_CALL_EVENT,
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
          rejectConn(
            new Error(`device link returned status ${res.statusCode}`),
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
            handleEvent(block, options);
            boundary = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => resolveConn());
        res.on("error", (error) => rejectConn(error));
      },
    );
    req.on("error", (error) => rejectConn(error));
    const onAbort = (): void => {
      req.destroy();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

function handleEvent(block: string, options: DesktopClientOptions): void {
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
  if (event !== TOOL_CALL_EVENT || dataLines.length === 0) return;
  // Run each call without blocking the read loop so the desktop can handle
  // several at once. The catch is a backstop: runToolCall already reports tool
  // failures, so reaching here means an unexpected internal error, not a tool
  // result, and must not become an unhandled rejection.
  runToolCall(dataLines.join("\n"), options).catch((error: unknown) => {
    options.onStatus?.(
      `tool dispatch error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function runToolCall(
  data: string,
  options: DesktopClientOptions,
): Promise<void> {
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
    await reportResult(options, {
      id,
      ok: false,
      output: "",
      error: "unknown tool",
    });
    return;
  }

  const outcome = await executeLocalTool(toolParse.data, record["params"], {
    rootDir: options.rootDir,
  });
  await reportResult(options, {
    id,
    ok: outcome.ok,
    output: outcome.output,
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  });
}

async function reportResult(
  options: DesktopClientOptions,
  result: { id: string; ok: boolean; output: string; error?: string },
): Promise<void> {
  try {
    await postJson({
      url: options.credentials.url,
      path: "/v1/devices/result",
      token: options.credentials.token,
      body: result,
    });
  } catch (error) {
    // The broker's abort and backstop free a call whose result never lands, so a
    // failed POST degrades to a tool error on the server rather than a hang.
    options.onStatus?.(
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
