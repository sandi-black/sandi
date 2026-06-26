import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type JsonResponse = {
  status: number;
  body: unknown;
};

// POSTs JSON to a path resolved against the server base URL and returns the
// status and parsed body. Resolves for any HTTP status; rejects only on a
// transport error. Picks http or https from the URL scheme so the reference
// client works against a local server or a TLS-terminated one.
export function postJson(input: {
  url: string;
  path: string;
  body: unknown;
  token?: string;
}): Promise<JsonResponse> {
  return new Promise((resolvePost, rejectPost) => {
    let target: URL;
    try {
      target = new URL(input.path, input.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
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
          resolvePost({
            status: res.statusCode ?? 0,
            body: parseMaybeJson(text),
          });
        });
      },
    );
    req.on("error", (error) => rejectPost(error));
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
