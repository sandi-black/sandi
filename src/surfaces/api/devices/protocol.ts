import { z } from "zod/v4";

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

// The proxy tools registered for api turns. The names are deliberately distinct
// from pi's seven built-ins (read, bash, edit, write, grep, find, ls), which the
// api surface disables with --no-builtin-tools: a shared name would be caught by
// pi's name-based tool exclusion and disabled along with the built-in.
export const LocalToolNameSchema = z.enum([
  "local_read",
  "local_write",
  "local_edit",
  "local_ls",
  "local_glob",
  "local_grep",
  "local_bash",
  // Machine-state tools. Unlike the file and shell tools, which run on the one
  // desktop leased for the turn, these read the shape of a desktop (its
  // monitors, its open windows, a screenshot) and accept a `desktop` selector so
  // Sandi can target any of the caller's connected desktops, not only the
  // current one. `local_list_desktops` is the discovery call that names them.
  "local_list_desktops",
  "local_list_monitors",
  "local_list_windows",
  "local_screenshot",
]);
export type LocalToolName = z.infer<typeof LocalToolNameSchema>;
export const LOCAL_TOOL_NAMES: readonly LocalToolName[] =
  LocalToolNameSchema.options;

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
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
});
export const LocalBashParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

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
export const LocalScreenshotParamsSchema = z.object({
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
});

export type LocalReadParams = z.infer<typeof LocalReadParamsSchema>;
export type LocalWriteParams = z.infer<typeof LocalWriteParamsSchema>;
export type LocalEditParams = z.infer<typeof LocalEditParamsSchema>;
export type LocalLsParams = z.infer<typeof LocalLsParamsSchema>;
export type LocalGlobParams = z.infer<typeof LocalGlobParamsSchema>;
export type LocalGrepParams = z.infer<typeof LocalGrepParamsSchema>;
export type LocalBashParams = z.infer<typeof LocalBashParamsSchema>;
export type LocalListDesktopsParams = z.infer<
  typeof LocalListDesktopsParamsSchema
>;
export type LocalListMonitorsParams = z.infer<
  typeof LocalListMonitorsParamsSchema
>;
export type LocalListWindowsParams = z.infer<
  typeof LocalListWindowsParamsSchema
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
    tool: z.literal("local_screenshot"),
    params: LocalScreenshotParamsSchema,
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
// so it survives the JSON hops back to the model. A screenshot is the only such
// artifact today; `output` still carries the textual summary that accompanies
// it. The desktop caps the encoded size (it downscales before encoding) so an
// image stays well within the result body limit.
//
// Both fields are parsed precisely, not accepted as any non-empty string: the
// mime type must be one the model can render, and the payload must be base64.
// A desktop result that names an unsupported type or carries non-base64 bytes is
// rejected at this boundary rather than travelling on as a typed image.
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"];
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
export const DeviceImageSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png"]),
  dataBase64: z.string().regex(BASE64_PATTERN, "must be base64-encoded"),
});
export type DeviceImage = z.infer<typeof DeviceImageSchema>;

// What the desktop POSTs back once it has run the call. `ok` is the tool's own
// success (a shell command exiting non-zero is still `ok: true` with the exit
// code in `output`); `ok: false` is reserved for a call the desktop refused or
// could not attempt (bad params, missing file, disallowed path). `output` is the
// textual evidence handed to the model; `image` rides along when a tool produced
// one (a screenshot), and the proxy maps it to an image block in the result.
export const DeviceResultSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  image: DeviceImageSchema.optional(),
});
export type DeviceResult = z.infer<typeof DeviceResultSchema>;

// The broker's reply to the pi child's /call: the result fields without the
// correlation id (the HTTP response already pairs with the request).
export type ToolCallOutcome = {
  ok: boolean;
  output: string;
  error?: string;
  image?: DeviceImage;
};

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
