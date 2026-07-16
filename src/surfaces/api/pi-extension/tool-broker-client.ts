import { request as httpRequest } from "node:http";

const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";
const CALL_TIMEOUT_MS = 11 * 60_000;
const CALL_MAX_BODY_BYTES = 8 * 1024 * 1024;
// Kept in lockstep with devices/protocol.ts because Pi loads this extension
// without the server's TypeScript path aliases.
const MAX_DEVICE_ERROR_CHARS = 10_000;

export type Broker = {
  url: string;
  token: string;
};

// Exported for tests: reads and validates the per-turn broker coordinates the
// api surface set on the pi child, or undefined when none was leased or the
// values are malformed. Validating the URL and token shape at this env boundary
// means a bad value disables the tools up front rather than failing later inside
// a tool call's post().
export function readBroker(): Broker | undefined {
  const rawUrl = process.env[TOOL_BROKER_URL_ENV]?.trim();
  const rawToken = process.env[TOOL_BROKER_TOKEN_ENV]?.trim();
  if (!rawUrl || !rawToken) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  // The broker listens on a loopback http origin that the api surface set on
  // this child. Pin it to http on 127.0.0.1: a non-loopback or non-http value
  // would mean the env was tampered with, and a tool call must never leave the
  // local hop.
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.hostname !== "127.0.0.1") return undefined;
  // The broker mints a hex secret (32 bytes -> exactly 64 hex chars). Require
  // that exact shape so a truncated or non-hex token is rejected here, not as a
  // late broker 401.
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return undefined;
  return { url: parsed.origin, token: rawToken };
}

export type ToolCallImage = {
  type: "image";
  mimeType: string;
  dataBase64: string;
};

export type ToolCallContent = { type: "text"; text: string } | ToolCallImage;

export type ToolCallOutcome = {
  ok: boolean;
  content: ToolCallContent[];
  error?: string;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

// Exported for tests: POSTs one tool call to the broker and maps the outcome to
// a pi tool result, throwing so pi surfaces a tool error when the desktop
// refuses the call or is unavailable. A tool that produced an image (a
// screenshot) returns it as an image block alongside its text summary.
export async function callBroker(
  broker: Broker,
  tool: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  return post(broker, { tool, params }, signal);
}

function post(
  broker: Broker,
  body: { tool: string; params: unknown },
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  return new Promise((resolvePost, rejectPost) => {
    if (signal?.aborted) {
      rejectPost(abortReason(signal, "local tool call aborted"));
      return;
    }
    let target: URL;
    try {
      target = new URL("/call", broker.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (payload.length > CALL_MAX_BODY_BYTES) {
      rejectPost(new Error("local tool call request exceeded 8 MiB"));
      return;
    }

    let settled = false;
    let responseStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      run();
    };
    const rejectOnce = (error: unknown): void => {
      settle(() =>
        rejectPost(error instanceof Error ? error : new Error(String(error))),
      );
    };
    const req = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": payload.length,
          authorization: `Bearer ${broker.token}`,
        },
      },
      (res) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        let received = 0;
        let ended = false;
        const declaredLength = parseContentLength(
          res.headers["content-length"],
        );
        if (
          declaredLength !== undefined &&
          declaredLength > CALL_MAX_BODY_BYTES
        ) {
          const error = new Error("tool broker response exceeded 8 MiB");
          rejectOnce(error);
          res.destroy();
          req.destroy();
          return;
        }
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > CALL_MAX_BODY_BYTES) {
            const error = new Error("tool broker response exceeded 8 MiB");
            rejectOnce(error);
            res.destroy(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on("aborted", () => {
          rejectOnce(
            new Error("tool broker response aborted before completion"),
          );
        });
        res.on("error", rejectOnce);
        res.on("end", () => {
          ended = true;
          const status = res.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (status === 503) {
            rejectOnce(
              new Error(
                "the desktop is not connected; local file and shell tools are unavailable",
              ),
            );
            return;
          }
          if (status !== 200) {
            rejectOnce(
              new Error(`tool broker returned status ${status}: ${raw}`),
            );
            return;
          }
          try {
            const outcome = parseOutcome(raw);
            settle(() => resolvePost(outcome));
          } catch (error) {
            rejectOnce(error);
          }
        });
        res.on("close", () => {
          if (!ended) {
            rejectOnce(
              new Error("tool broker response closed before completion"),
            );
          }
        });
      },
    );
    const onAbort = (): void => {
      const error = abortReason(signal, "local tool call aborted");
      rejectOnce(error);
      req.destroy(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error("local tool call timed out");
      rejectOnce(error);
      req.destroy(error);
    }, CALL_TIMEOUT_MS);
    req.on("error", rejectOnce);
    req.on("close", () => {
      if (!settled && !responseStarted) {
        rejectOnce(
          new Error("tool broker connection closed before a response"),
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

function abortReason(signal: AbortSignal | undefined, fallback: string): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

function parseOutcome(raw: string): ToolCallOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tool broker returned a non-object result");
  }
  const record: Record<string, unknown> = { ...parsed };
  const ok = record["ok"];
  const rawContent = record["content"];
  if (typeof ok !== "boolean" || !Array.isArray(rawContent)) {
    throw new Error("tool broker result was malformed");
  }
  if (rawContent.length > 32) {
    throw new Error("tool broker returned too many content blocks");
  }
  const content = rawContent.map(parseContentBlock);
  const textChars = content.reduce(
    (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
    0,
  );
  const imageChars = content.reduce(
    (sum, block) =>
      sum + (block.type === "image" ? block.dataBase64.length : 0),
    0,
  );
  if (textChars > 100_000 || imageChars > 6 * 1024 * 1024) {
    throw new Error("tool broker result content exceeded its limit");
  }
  const error = record["error"];
  if (typeof error === "string" && error.length > MAX_DEVICE_ERROR_CHARS) {
    throw new Error("tool broker error exceeded 10000 characters");
  }
  const isError = record["isError"];
  const structuredContent = parseStructuredContent(record["structuredContent"]);
  return {
    ok,
    content,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function parseContentBlock(value: unknown): ToolCallContent {
  if (typeof value !== "object" || value === null) {
    throw new Error("tool broker returned a malformed content block");
  }
  const record: Record<string, unknown> = { ...value };
  if (record["type"] === "text" && typeof record["text"] === "string") {
    return { type: "text", text: record["text"] };
  }
  if (record["type"] === "image") return parseImage(record);
  throw new Error("tool broker returned a malformed content block");
}

function parseStructuredContent(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool broker returned malformed structured content");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) {
    throw new Error("tool broker structured content exceeded 1 MiB");
  }
  return { ...value };
}

// The supported image types, the canonical-base64 shape, and the magic-byte
// check, restated here (this extension cannot import the protocol module) so the
// proxy parses an image result exactly as precisely as the protocol's
// DeviceImageSchema does on the wire.
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isAlphabet && code !== 61) return undefined;
    if (code === 61 && index < value.length - 2) return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

// Confirms the decoded bytes start with the declared type's signature, so a
// payload cannot claim image/png while carrying jpeg (or arbitrary) bytes.
function imageBytesMatchMime(mimeType: string, dataBase64: string): boolean {
  const bytes = decodeCanonicalBase64(dataBase64);
  if (!bytes) return false;
  if (mimeType === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

// Parses an optional image payload off a broker result. Absent is fine (most
// tools return none). A present payload must be a well-formed, supported image
// whose bytes match its declared type: anything malformed throws so the call
// fails closed rather than being reported successful with the image dropped.
function parseImage(value: unknown): ToolCallImage {
  if (typeof value !== "object") {
    throw new Error("tool broker returned a malformed image");
  }
  const record: Record<string, unknown> = { ...value };
  const mimeType = record["mimeType"];
  const dataBase64 = record["dataBase64"];
  if (typeof mimeType !== "string" || typeof dataBase64 !== "string") {
    throw new Error("tool broker returned a malformed image");
  }
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `tool broker returned an unsupported image type: ${mimeType}`,
    );
  }
  if (decodeCanonicalBase64(dataBase64) === undefined) {
    throw new Error("tool broker returned image data that was not base64");
  }
  if (!imageBytesMatchMime(mimeType, dataBase64)) {
    throw new Error("tool broker image bytes do not match the declared type");
  }
  return { type: "image", mimeType, dataBase64 };
}
