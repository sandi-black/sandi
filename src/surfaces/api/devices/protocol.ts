import { z } from "zod/v4";
import { VisualObservationSchema } from "@/surfaces/api/client/visual-observation";
import {
  DesktopFileAttachmentSchema,
  DesktopFileTransferParamsSchema,
} from "@/surfaces/api/devices/desktop-file-transfer";
import {
  LocalMcpConfigureParamsSchema,
  LocalMcpParamsSchema,
} from "@/surfaces/api/devices/mcp-protocol";
import { MAX_LOCAL_GREP_PATTERN_CHARS } from "@/surfaces/api/devices/search-limits";

export const MAX_LOCAL_BASH_TIMEOUT_MS = 600_000;
export const MAX_LOCAL_SCRIPT_TIMEOUT_MS = 600_000;
export const MAX_LOCAL_SCRIPT_SOURCE_CHARS = 80_000;
export const MAX_NATIVE_WAIT_TIMEOUT_MS = 30_000;

// The hands-local wire protocol. An api-surface turn runs server-side, but its
// file and shell tools execute on the human's own desktop. Three hops carry one
// tool call:
//
//   pi child  --HTTP-->  loopback broker  --SSE-->  desktop client
//             <--HTTP--                   <--HTTP--
//
// The pi child POSTs a tool call to the loopback broker (`BrokerCall`). The
// broker pushes it to the paired desktop over a long-lived SSE stream as a
// `tool_call` event (`ToolDispatch`). The desktop executes locally and POSTs the
// outcome back (`DeviceResult`), which the broker returns as the loopback HTTP
// response. Every shape on the wire is parsed at its boundary so neither side
// trusts the other's JSON.

// Per-tool parameter schemas. The desktop client validates an incoming call
// against these before it touches the filesystem or spawns a shell, so a
// malformed dispatch is rejected rather than acted on. The pi-side extension
// describes the same shapes in TypeBox (it cannot share this module), so the two
// schemas are the two ends of one JSON contract.
//
// Every tool carries an optional `desktop` selector: the broker reads it to
// route the call to one of the caller's connected desktops, then the desktop
// client ignores it (it is routing metadata, resolved server-side, not an
// argument the executor acts on). Omitting it runs on the turn's own desktop.
export const LocalReadParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export const LocalWriteParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  path: z.string().min(1),
  content: z.string(),
});
export const LocalEditParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
export const LocalLsParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  path: z.string().min(1),
});
export const LocalGlobParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
});
export const LocalGrepParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  pattern: z.string().min(1).max(MAX_LOCAL_GREP_PATTERN_CHARS),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
});
export const LocalBashParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_LOCAL_BASH_TIMEOUT_MS)
    .optional(),
});
export const LocalJsRunParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  code: z.string().min(1).max(MAX_LOCAL_SCRIPT_SOURCE_CHARS),
  cwd: z.string().min(1).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_LOCAL_SCRIPT_TIMEOUT_MS)
    .optional(),
});
export const LocalAutoItRunParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  code: z.string().min(1).max(MAX_LOCAL_SCRIPT_SOURCE_CHARS),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_LOCAL_SCRIPT_TIMEOUT_MS)
    .optional(),
});

const NativeWindowIdentitySchema = z.object({
  hwnd: z
    .string()
    .regex(/^[1-9]\d*$/, "must be a positive decimal window handle"),
  pid: z.number().int().positive(),
});

const NativeControlIdentitySchema = NativeWindowIdentitySchema.extend({
  automationId: z.string().max(1_024),
  controlType: z.number().int().positive(),
  name: z.string().max(4_096),
  className: z.string().max(1_024),
  path: z
    .string()
    .regex(/^\d+(?:\/\d+)*$/)
    .max(2_048),
});

const NativeInspectFiltersSchema = z.object({
  automationId: z.string().max(1_024).optional(),
  controlType: z.number().int().positive().optional(),
  name: z.string().max(4_096).optional(),
  className: z.string().max(1_024).optional(),
});

const NativeTargetActionSchema = z.object({
  desktop: z.string().min(1).optional(),
  target: NativeControlIdentitySchema,
});

export const LocalNativeParamsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("inspect"),
    desktop: z.string().min(1).optional(),
    window: NativeWindowIdentitySchema,
    filters: NativeInspectFiltersSchema.optional(),
    includeDocumentChildren: z.boolean().optional(),
    maxNodes: z.number().int().min(1).max(256).optional(),
    maxResults: z.number().int().min(1).max(128).optional(),
  }),
  NativeTargetActionSchema.extend({ action: z.literal("describe") }),
  NativeTargetActionSchema.extend({ action: z.literal("get_value") }),
  NativeTargetActionSchema.extend({
    action: z.literal("set_value"),
    value: z.string().max(65_536),
  }),
  NativeTargetActionSchema.extend({
    action: z.literal("insert_text"),
    text: z.string().min(1).max(65_536),
  }),
  NativeTargetActionSchema.extend({ action: z.literal("invoke") }),
  NativeTargetActionSchema.extend({ action: z.literal("toggle") }),
  NativeTargetActionSchema.extend({ action: z.literal("select") }),
  NativeTargetActionSchema.extend({
    action: z.literal("wait_value"),
    value: z.string().max(65_536),
    timeoutMs: z.number().int().positive().max(MAX_NATIVE_WAIT_TIMEOUT_MS),
  }),
  z.object({
    action: z.literal("wait_window"),
    desktop: z.string().min(1).optional(),
    window: NativeWindowIdentitySchema,
    state: z.enum(["exists", "closed"]),
    timeoutMs: z.number().int().positive().max(MAX_NATIVE_WAIT_TIMEOUT_MS),
  }),
  z.object({
    action: z.literal("visual_click"),
    desktop: z.string().min(1).optional(),
    visualObservation: VisualObservationSchema,
    x: z.number().min(0).lt(1),
    y: z.number().min(0).lt(1),
  }),
]);

// The state tools. They take the same `desktop` selector as every other tool;
// local_list_desktops is the discovery call that names the desktops a selector
// can target, so it takes no arguments and the broker answers it from its own
// registry rather than dispatching it to a desktop.
export const LocalListDesktopsParamsSchema = z.object({});
export const LocalListMonitorsParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
});
export const LocalListWindowsParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
});
export const LocalDesktopActivityParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
});
export const LocalScreenshotParamsSchema = z
  .object({
    desktop: z.string().min(1).optional(),
    // Capture one monitor (by index or device name from local_list_monitors) or
    // one window (by handle or title from local_list_windows). At most one; with
    // neither, the primary monitor is captured.
    monitor: z.string().min(1).optional(),
    window: z.string().min(1).optional(),
    // Longest-edge cap in pixels before encoding. The desktop downscales to this
    // so a 4K screen does not return a multi-megabyte image; defaulted and clamped
    // on the desktop, not here.
    maxDimension: z.number().int().positive().optional(),
  })
  .refine(
    (params) => params.monitor === undefined || params.window === undefined,
    {
      message: "monitor and window are mutually exclusive",
    },
  );

export type LocalReadParams = z.infer<typeof LocalReadParamsSchema>;
export type LocalWriteParams = z.infer<typeof LocalWriteParamsSchema>;
export type LocalEditParams = z.infer<typeof LocalEditParamsSchema>;
export type LocalLsParams = z.infer<typeof LocalLsParamsSchema>;
export type LocalGlobParams = z.infer<typeof LocalGlobParamsSchema>;
export type LocalGrepParams = z.infer<typeof LocalGrepParamsSchema>;
export type LocalBashParams = z.infer<typeof LocalBashParamsSchema>;
export type LocalJsRunParams = z.infer<typeof LocalJsRunParamsSchema>;
export type LocalAutoItRunParams = z.infer<typeof LocalAutoItRunParamsSchema>;
export type LocalNativeParams = z.infer<typeof LocalNativeParamsSchema>;
export type LocalListDesktopsParams = z.infer<
  typeof LocalListDesktopsParamsSchema
>;
export type LocalListMonitorsParams = z.infer<
  typeof LocalListMonitorsParamsSchema
>;
export type LocalListWindowsParams = z.infer<
  typeof LocalListWindowsParamsSchema
>;
export type LocalDesktopActivityParams = z.infer<
  typeof LocalDesktopActivityParamsSchema
>;
export type LocalScreenshotParams = z.infer<typeof LocalScreenshotParamsSchema>;

// What the pi child POSTs to the loopback broker, and what the broker pushes on
// to the desktop. A discriminated union keyed by `tool`: each tool is paired
// with its own params schema, so a call naming one tool but carrying another's
// params (or a tool Sandi does not proxy) is rejected at the broker boundary
// rather than forwarded as opaque JSON. The desktop re-validates before it
// touches the disk, but the precise shape is established here, once, on entry.
export const BrokerCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("local_read"), params: LocalReadParamsSchema }),
  z.object({ tool: z.literal("local_write"), params: LocalWriteParamsSchema }),
  z.object({ tool: z.literal("local_edit"), params: LocalEditParamsSchema }),
  z.object({ tool: z.literal("local_ls"), params: LocalLsParamsSchema }),
  z.object({ tool: z.literal("local_glob"), params: LocalGlobParamsSchema }),
  z.object({ tool: z.literal("local_grep"), params: LocalGrepParamsSchema }),
  z.object({ tool: z.literal("local_bash"), params: LocalBashParamsSchema }),
  z.object({ tool: z.literal("local_js_run"), params: LocalJsRunParamsSchema }),
  z.object({
    tool: z.literal("local_autoit_run"),
    params: LocalAutoItRunParamsSchema,
  }),
  z.object({
    tool: z.literal("local_native"),
    params: LocalNativeParamsSchema,
  }),
  z.object({
    tool: z.literal("local_list_desktops"),
    params: LocalListDesktopsParamsSchema,
  }),
  z.object({
    tool: z.literal("local_list_monitors"),
    params: LocalListMonitorsParamsSchema,
  }),
  z.object({
    tool: z.literal("local_list_windows"),
    params: LocalListWindowsParamsSchema,
  }),
  z.object({
    tool: z.literal("local_desktop_activity"),
    params: LocalDesktopActivityParamsSchema,
  }),
  z.object({
    tool: z.literal("local_screenshot"),
    params: LocalScreenshotParamsSchema,
  }),
  z.object({
    tool: z.literal("local_transfer_file"),
    params: DesktopFileTransferParamsSchema,
  }),
  z.object({ tool: z.literal("local_mcp"), params: LocalMcpParamsSchema }),
  z.object({
    tool: z.literal("local_mcp_configure"),
    params: LocalMcpConfigureParamsSchema,
  }),
]);
export type BrokerCall = z.infer<typeof BrokerCallSchema>;

// What the broker pushes to the desktop over SSE as the data of a `tool_call`
// event: a validated call plus an `id` that correlates the eventual result back
// to it, so many calls can be in flight on one stream at once. Parsing this once
// on arrival hands the desktop typed params, never raw JSON it has to reach into.
export const ToolDispatchSchema = z
  .object({ id: z.string().min(1) })
  .and(BrokerCallSchema);
export type ToolDispatch = z.infer<typeof ToolDispatchSchema>;

// Just the correlation id of a dispatch. The desktop parses this first so it can
// answer even a call whose tool or params fail the full ToolDispatchSchema, by
// reporting a failure against the right id rather than dropping it silently.
export const ToolDispatchEnvelopeSchema = z.object({ id: z.string().min(1) });

// A binary artifact a tool produces alongside its text, carried base64-encoded
// so it survives the JSON hops. A screenshot is the model-visible artifact;
// `output` carries its textual summary. A private desktop-to-Discord call can
// instead carry `attachment`, whose bytes the broker sends to its surface
// callback without exposing them to the model. Both payloads stay below the
// result body limit.
//
// The image is parsed precisely, not accepted as a base64-looking string: the
// mime type is one the model can render, the payload is canonical base64, and
// the decoded bytes carry the magic number for the declared type. A result that
// fails any of these is rejected at the boundary rather than carried as a typed
// image that only fails later when mapped to a model image block.
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

// V8's regexp engine can overflow its stack on multi-megabyte repeated
// patterns. Decode and round-trip instead: this stays linear, rejects ignored
// junk and non-zero pad bits, and proves the text is the unique base64 spelling
// of the bytes the rest of the boundary validates.
export function decodeCanonicalBase64(value: string): Buffer | undefined {
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

export function isCanonicalBase64(value: string): boolean {
  return decodeCanonicalBase64(value) !== undefined;
}

// True when the decoded bytes begin with the magic number for the declared mime
// type, so a payload labelled image/jpeg is genuinely JPEG and not arbitrary
// base64 that merely decodes.
export function imageBytesMatchMime(
  mimeType: string,
  dataBase64: string,
): boolean {
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

export const DeviceImageSchema = z
  .object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    dataBase64: z
      .string()
      .refine(isCanonicalBase64, "must be canonical base64"),
  })
  .refine((image) => imageBytesMatchMime(image.mimeType, image.dataBase64), {
    message: "image bytes do not match the declared mime type",
    path: ["dataBase64"],
  });
export type DeviceImage = z.infer<typeof DeviceImageSchema>;

export const MAX_DEVICE_CONTENT_BLOCKS = 32;
export const MAX_DEVICE_TEXT_CHARS = 100_000;
export const MAX_DEVICE_IMAGE_BASE64_CHARS = 6 * 1024 * 1024;
export const MAX_DEVICE_ERROR_CHARS = 10_000;

export const DeviceContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  DeviceImageSchema.extend({ type: z.literal("image") }),
]);
export type DeviceContent = z.infer<typeof DeviceContentSchema>;

export const DeviceContentListSchema = z
  .array(DeviceContentSchema)
  .max(MAX_DEVICE_CONTENT_BLOCKS)
  .superRefine((content, context) => {
    let textChars = 0;
    let imageChars = 0;
    for (const block of content) {
      if (block.type === "text") textChars += block.text.length;
      else imageChars += block.dataBase64.length;
    }
    if (textChars > MAX_DEVICE_TEXT_CHARS) {
      context.addIssue({
        code: "custom",
        message: `aggregate text exceeds ${MAX_DEVICE_TEXT_CHARS} characters`,
      });
    }
    if (imageChars > MAX_DEVICE_IMAGE_BASE64_CHARS) {
      context.addIssue({
        code: "custom",
        message: `aggregate image data exceeds ${MAX_DEVICE_IMAGE_BASE64_CHARS} base64 characters`,
      });
    }
  });

const StructuredContentSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 1_048_576,
    "structured content exceeds 1 MiB",
  );

// What the desktop POSTs back once it has run the call. `ok` is the tool's own
// success (a shell command exiting non-zero is still `ok: true` with the exit
// code in `output`); `ok: false` is reserved for a call the desktop refused or
// could not attempt (bad params, missing file, disallowed path). `output` is the
// textual evidence handed to the model; `image` rides along when a tool produced
// one (a screenshot), and the proxy maps it to an image block. `attachment` is
// reserved for the private Discord transfer call and rejected by public /call.
export const DeviceResultSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  content: DeviceContentListSchema,
  error: z.string().max(MAX_DEVICE_ERROR_CHARS).optional(),
  isError: z.boolean().optional(),
  structuredContent: StructuredContentSchema.optional(),
  attachment: DesktopFileAttachmentSchema.optional(),
});
export type DeviceResult = z.infer<typeof DeviceResultSchema>;

// The broker's reply to the pi child's /call: the result fields without the
// correlation id (the HTTP response already pairs with the request).
export const ToolCallOutcomeSchema = DeviceResultSchema.omit({ id: true });
export type ToolCallOutcome = z.infer<typeof ToolCallOutcomeSchema>;

// SSE event name for a dispatched tool call. Heartbeats are sent as SSE comment
// lines (": ping") which carry no event and are ignored by the client parser.
export const TOOL_CALL_EVENT = "tool_call";

// SSE event name telling the desktop to stop an in-flight call. Sent when a turn
// aborts (or its backstop fires) while the link is still up: the broker has
// already stopped waiting, so the desktop should abandon the work rather than
// run it to completion and POST a result no one is holding a pending call for.
// Carries the same `id` as the original dispatch.
export const TOOL_CANCEL_EVENT = "tool_cancel";
export const ToolCancelSchema = z.object({
  id: z.string().min(1),
});
export type ToolCancel = z.infer<typeof ToolCancelSchema>;

// Environment variables the api surface sets on the pi child so the proxy
// extension can reach the loopback broker. Defined here as the single source of
// truth; the extension reads the same names by string since it cannot import
// this module (pi loads extensions without the tsconfig path alias).
export const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
export const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";

// The turn id the api surface sets on the pi child so a streamed response delta
// can be tagged with the turn it belongs to. The desktop is one link carrying
// many turns over its life, so each delta names its turn; the REPL matches them
// to the turn it is currently awaiting and ignores any stragglers from a turn it
// has already finished. Read by the streaming extension by string, same reason
// as the broker env above.
export const TURN_ID_ENV = "SANDI_TURN_ID";

// Phase 3: streaming the assistant's response back as it is generated. A turn
// still runs server-side, but the desktop sees the text appear token by token
// rather than waiting for the final HTTP response. The path reuses the hands-
// local plumbing:
//
//   pi child  --HTTP-->  loopback broker  --SSE-->  desktop client
//
// An api-only pi extension subscribes to the model's streaming events inside the
// child and POSTs each delta to the broker's streaming ingress. The broker
// relays it to the paired desktop over the same SSE stream as a `response_chunk`
// event. Unlike a tool call there is no reply: deltas flow one way, and the turn
// POST's final body remains the authoritative record of the completed response.
export const RESPONSE_CHUNK_EVENT = "response_chunk";

// One streamed message on the response channel, shared by the child->broker
// ingress and the broker->desktop SSE data (one schema, both ends, like
// BrokerCall). A `delta` carries the next slice of generated text; `channel`
// separates the visible answer from the model's thinking so the desktop can
// render or suppress each. An `end` marks a turn's stream complete so the REPL
// can finalize promptly rather than waiting on the turn POST. `seq` is a
// per-turn monotonic counter: the stream is ordered over one TCP link, but the
// counter lets the desktop detect a gap and ignore a late duplicate.
export const ResponseChunkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("delta"),
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    channel: z.enum(["text", "thinking"]),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("end"),
    turnId: z.string().min(1),
    seq: z.number().int().nonnegative(),
  }),
]);
export type ResponseChunk = z.infer<typeof ResponseChunkSchema>;

// An outbound attachment Sandi hands back mid-turn: the `attach_to_reply`
// extension tool writes a file to the human's own desktop (with her local_*
// tools) and reports its path here so the desktop client can find and surface
// it, mirroring how a response_chunk carries the outbound text. `path` is a
// hands-local path on the caller's machine, not a server path; the server never
// reads it. `seq` is a per-turn monotonic counter, the same ordering discipline
// as ResponseChunk, assigned by the extension rather than reusing the chunk
// stream's counter (the two channels are independent).
// path stays a bounded free-form path (absolute or desktop-relative by the
// tool's contract; the desktop resolves it against its own root), but name is
// a single bounded filename (the desktop offers it as a save-as suggestion)
// and mimeType a plain type/subtype token pair.
export const RESPONSE_ATTACHMENT_EVENT = "response_attachment";

// A safe single filename for the save-as suggestion: no path separators and no
// C0/DEL control bytes (code points 0-31 and 127). Code-point checks keep the
// source plain ASCII rather than embedding a control-char regex literal.
function isSafeAttachmentName(value: string): boolean {
  for (const char of value) {
    if (char === "/" || char === "\\") return false;
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export const ResponseAttachmentSchema = z.object({
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  // A NUL byte makes the desktop's fs calls throw once it resolves this to an
  // absolute path, so it is rejected here even though the server never reads
  // the path itself.
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => !value.includes(String.fromCharCode(0)),
      "path must not contain a NUL byte",
    ),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      isSafeAttachmentName,
      "name must be a filesystem-safe single filename",
    )
    .optional(),
  mimeType: z
    .string()
    .regex(/^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/)
    .optional(),
});
export type ResponseAttachment = z.infer<typeof ResponseAttachmentSchema>;
