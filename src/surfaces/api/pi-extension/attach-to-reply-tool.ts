import { request as httpRequest } from "node:http";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Registers `attach_to_reply`, the outbound half of hands-local attachments.
// Sandi writes a file on the human's own desktop with her local_* tools (or
// finds one already there), then calls this tool to tell the desktop client
// which path to surface as an attachment on the current turn's reply. It POSTs
// to the same per-turn loopback broker the local_* tools and the response
// stream use, on a dedicated ingress (`POST /attachment`) the broker relays to
// the device link as a `response_attachment` event.
//
// This file is loaded directly by the pi CLI, which does not honor the tsconfig
// path alias, so (like local-exec-tools.ts and response-stream.ts) it restates
// the broker and turn-id env var names and the response-attachment wire shape
// that src/surfaces/api/devices/protocol.ts owns, rather than importing it.

const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";
const TURN_ID_ENV = "SANDI_TURN_ID";

// An attachment notice is a small JSON body relayed without a device reply to
// wait on, so a slow POST means the link is wedged, not busy.
const CALL_TIMEOUT_MS = 10_000;

export type AttachTarget = {
  url: string;
  token: string;
  turnId: string;
};

// Both results below share one details shape (ok as plain boolean, not a
// literal) so the tool's execute() can return either from the same branch
// without TypeScript narrowing the whole function to whichever branch it
// infers the return type from first.
export type AttachToReplyResult = {
  content: [{ type: "text"; text: string }];
  details: { tool: "attach_to_reply"; ok: boolean };
};

// The graceful result when this surface holds no desktop link (or the turn
// leased no broker), exported so a test can assert the model-visible text
// without standing up a fake ExtensionAPI to invoke the registered tool.
// Answering this rather than throwing lets the model recover (e.g. describe
// the file's contents in text) rather than failing the whole turn.
export function noDesktopLinkResult(): AttachToReplyResult {
  return {
    content: [
      {
        type: "text",
        text: "no desktop link on this surface: attach_to_reply is only available on a turn with a connected desktop",
      },
    ],
    details: { tool: "attach_to_reply", ok: false },
  };
}

// The success result once the broker has accepted the notice.
export function attachedResult(displayName: string): AttachToReplyResult {
  return {
    content: [{ type: "text", text: `attached ${displayName} to this reply` }],
    details: { tool: "attach_to_reply", ok: true },
  };
}

// The refusal for parameters the broker would reject anyway, answered here so
// the model gets a precise correction instead of a broker 400.
export function invalidParamsResult(reason: string): AttachToReplyResult {
  return {
    content: [
      { type: "text", text: `invalid attach_to_reply call: ${reason}` },
    ],
    details: { tool: "attach_to_reply", ok: false },
  };
}

// The parsed shape of an attach_to_reply call: what validateAttachParams
// produces and the only thing execute() may hand to the broker.
export type AttachToReplyParams = {
  path: string;
  name?: string;
};

// Exported for tests: parses the model's raw parameters (an agent boundary,
// so `unknown` in and a bounded AttachToReplyParams out) into the exact shape
// the broker's ResponseAttachmentSchema accepts (restated here because this
// file loads outside the alias-aware runtime, like the env names above).
// `path` is a bounded path, absolute or desktop-relative; `name` must be a
// single bounded filename since the desktop offers it as a save-as name.
export function validateAttachParams(
  raw: unknown,
): { ok: true; params: AttachToReplyParams } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "params must be an object" };
  }
  const rawPath = "path" in raw ? raw.path : undefined;
  if (typeof rawPath !== "string") {
    return { ok: false, reason: "path must be a string" };
  }
  const path = rawPath.trim();
  if (path.length === 0 || path.length > 4096) {
    return { ok: false, reason: "path must be 1 to 4096 characters" };
  }
  if (path.includes(String.fromCharCode(0))) {
    return { ok: false, reason: "path must not contain a NUL byte" };
  }
  const rawName = "name" in raw ? raw.name : undefined;
  if (rawName !== undefined && typeof rawName !== "string") {
    return { ok: false, reason: "name must be a string when present" };
  }
  const name = rawName?.trim();
  if (name !== undefined) {
    if (name.length === 0 || name.length > 200) {
      return { ok: false, reason: "name must be 1 to 200 characters" };
    }
    if (!isSafeFilename(name)) {
      return {
        ok: false,
        reason: "name must be a filesystem-safe single filename",
      };
    }
  }
  return {
    ok: true,
    params: { path, ...(name !== undefined ? { name } : {}) },
  };
}

// A safe single filename: no path separators and no C0/DEL control bytes (code
// points 0-31 and 127), which corrupt the name the desktop offers as a save-as
// suggestion. Code-point checks keep the source plain ASCII.
function isSafeFilename(value: string): boolean {
  for (const char of value) {
    if (char === "/" || char === "\\") return false;
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export default function attachToReplyToolExtension(pi: ExtensionAPI): void {
  const target = readAttachTarget();
  // Per-turn monotonic counter, independent of the response-chunk stream's own
  // seq: the two are separate ordered channels on the same link.
  let seq = 0;

  pi.registerTool(
    defineTool({
      name: "attach_to_reply",
      label: "Attach File To Reply",
      description:
        "Attach a file already on the human's desktop to your current reply, so the desktop client surfaces it alongside your answer. Write the file with your local_* tools first, then call this with its path.",
      parameters: Type.Object({
        path: Type.String({
          minLength: 1,
          maxLength: 4096,
          description:
            "Absolute or desktop-relative path to the file to attach.",
        }),
        name: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 200,
            description:
              "Display name for the attachment (defaults to the file name).",
          }),
        ),
      }),
      async execute(_id, params) {
        if (!target) return noDesktopLinkResult();
        const validated = validateAttachParams(params);
        if (!validated.ok) return invalidParamsResult(validated.reason);
        const attachment = {
          turnId: target.turnId,
          seq: seq++,
          path: validated.params.path,
          ...(validated.params.name !== undefined
            ? { name: validated.params.name }
            : {}),
        };
        await postAttachment(target, attachment);
        return attachedResult(validated.params.name ?? validated.params.path);
      },
    }),
  );
}

// Exported for tests: reads and validates the per-turn broker coordinates plus
// turn id, mirroring readBroker in local-exec-tools.ts and readStreamTarget in
// response-stream.ts. Undefined disables the tool's broker path entirely (the
// registered tool still exists so the model gets a clear refusal instead of an
// unknown-tool error).
export function readAttachTarget(): AttachTarget | undefined {
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

// Exported for tests: POSTs one attachment notice to the broker's ingress and
// throws with a message the tool surfaces to the model on anything but 202, so
// a lost link or a stale turn shows up as a tool error rather than a silent
// no-op the model believes succeeded.
export async function postAttachment(
  target: AttachTarget,
  attachment: unknown,
): Promise<void> {
  const status = await post(target, attachment);
  if (status === 503) {
    throw new Error(
      "the desktop is not connected; attach_to_reply is unavailable",
    );
  }
  if (status !== 202) {
    throw new Error(
      `tool broker returned status ${status} for attach_to_reply`,
    );
  }
}

function post(target: AttachTarget, body: unknown): Promise<number> {
  return new Promise((resolvePost, rejectPost) => {
    let url: URL;
    try {
      url = new URL("/attachment", target.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
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
        res.resume();
        res.on("end", () => resolvePost(res.statusCode ?? 0));
        // A broker that dies after sending headers must reject through
        // postAttachment, not escape as an unhandled 'error' emission or
        // leave this promise unsettled forever.
        res.on("error", (error) => rejectPost(error));
      },
    );
    req.setTimeout(CALL_TIMEOUT_MS, () => {
      req.destroy(new Error("attach_to_reply POST timed out"));
    });
    req.on("error", (error) => rejectPost(error));
    req.end(payload);
  });
}
