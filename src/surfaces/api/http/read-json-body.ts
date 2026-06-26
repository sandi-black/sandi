import type { IncomingMessage } from "node:http";

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

    const finish = (result: JsonBodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBody(result);
    };

    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, status: 408, error: "request_timeout" });
    }, options.timeoutMs);

    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > options.maxBytes) {
        // Stop buffering and deliberately stop reading so the caller can write
        // the JSON 413 to the still-open response, instead of destroying the
        // socket out from under the error. The server `requestTimeout` bounds
        // any remaining unread body.
        request.pause();
        request.removeAllListeners("data");
        finish({ ok: false, status: 413, error: "payload_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: false, status: 400, error: "empty_body" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, error: "invalid_json" });
      }
    });
    request.on("error", () => {
      finish({ ok: false, status: 400, error: "request_error" });
    });
  });
}
