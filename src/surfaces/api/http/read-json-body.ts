import type { IncomingMessage, ServerResponse } from "node:http";
import { TextDecoder } from "node:util";

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

export type ReadJsonBodyOptions = {
  // Hard cap on the buffered body. Once exceeded the read stops and answers 413
  // on the still-open response rather than destroying the socket.
  maxBytes: number;
  // Deadline for the whole body to arrive, defeating a slow-body client. This is
  // independent of any longer-running work the handler does afterward.
  timeoutMs: number;
  response: ServerResponse;
  signal?: AbortSignal;
};

// Reads and JSON-parses a request body within a size and time budget. Resolves
// (never rejects) with a discriminated result so callers map failures to a
// status without a try/catch. Shared by every JSON route on the API surface so
// the size and slow-body guards are identical everywhere.
export function readJsonBody(
  request: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<JsonBodyResult> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
      options.signal?.removeEventListener("abort", onSignalAbort);
    };

    const finish = (result: JsonBodyResult, discard = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (discard) {
        // Send the status before closing the connection, then discard any body
        // bytes already in flight without retaining them. `Connection: close`
        // prevents unread bytes from becoming the next keep-alive request.
        options.response.shouldKeepAlive = false;
        if (!options.response.headersSent) {
          options.response.setHeader("connection", "close");
        }
        options.response.once("finish", () => {
          request.socket.end();
        });
        request.once("error", () => {});
        request.resume();
      }
      resolveBody(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, status: 408, error: "request_timeout" }, true);
    }, options.timeoutMs);

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > options.maxBytes) {
        finish({ ok: false, status: 413, error: "payload_too_large" }, true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, total))
          .trim();
      } catch {
        finish({ ok: false, status: 400, error: "invalid_encoding" });
        return;
      }
      if (!raw) {
        finish({ ok: false, status: 400, error: "empty_body" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, error: "invalid_json" });
      }
    };
    const onError = (): void => {
      finish({ ok: false, status: 400, error: "request_error" });
    };
    const onAborted = (): void => {
      finish({ ok: false, status: 400, error: "request_aborted" });
    };
    const onClose = (): void => {
      if (!request.complete) onAborted();
    };
    const onSignalAbort = (): void => {
      finish({ ok: false, status: 408, error: "request_aborted" }, true);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    request.once("close", onClose);
    if (options.signal?.aborted) {
      onSignalAbort();
    } else {
      options.signal?.addEventListener("abort", onSignalAbort, { once: true });
    }
  });
}
