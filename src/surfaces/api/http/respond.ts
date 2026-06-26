import type { ServerResponse } from "node:http";

// RFC 7235 `Bearer <token68>`: a single token of the token68 alphabet with no
// embedded or trailing whitespace and no extra fields. `Bearer abc def` and
// `Bearer ` are both rejected.
const BEARER_HEADER = /^Bearer (?<token>[A-Za-z0-9._~+/-]+=*)$/i;

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return BEARER_HEADER.exec(header.trim())?.groups?.["token"];
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
