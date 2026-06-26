import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type JsonResponse = {
  status: number;
  body: unknown;
};

// A POST that never returns must not pin a request forever (it would keep the
// caller's task and any bookkeeping alive). Bound every request by default.
const DEFAULT_TIMEOUT_MS = 30_000;

// POSTs JSON to a path resolved against the server base URL and returns the
// status and parsed body. Resolves for any HTTP status; rejects only on a
// transport error, a timeout, or an aborted signal. Picks http or https from the
// URL scheme so the reference client works against a local server or a
// TLS-terminated one.
export function postJson(input: {
  url: string;
  path: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<JsonResponse> {
  return new Promise((resolvePost, rejectPost) => {
    let target: URL;
    try {
      target = new URL(input.path, input.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (input.signal?.aborted) {
      rejectPost(new Error("request aborted before it started"));
      return;
    }
    const payload = Buffer.from(JSON.stringify(input.body), "utf8");
    const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": payload.length,
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          settle(() =>
            resolvePost({
              status: res.statusCode ?? 0,
              body: parseMaybeJson(text),
            }),
          );
        });
      },
    );

    let done = false;
    const onAbort = (): void => {
      req.destroy(new Error("request aborted"));
    };
    const settle = (run: () => void): void => {
      if (done) return;
      done = true;
      input.signal?.removeEventListener("abort", onAbort);
      run();
    };
    req.setTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", (error) => settle(() => rejectPost(error)));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    req.end(payload);
  });
}

function parseMaybeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
