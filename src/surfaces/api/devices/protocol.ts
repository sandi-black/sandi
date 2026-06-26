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
]);
export type LocalToolName = z.infer<typeof LocalToolNameSchema>;
export const LOCAL_TOOL_NAMES: readonly LocalToolName[] =
  LocalToolNameSchema.options;

// Per-tool parameter schemas. The desktop client validates an incoming call
// against these before it touches the filesystem or spawns a shell, so a
// malformed dispatch is rejected rather than acted on. The pi-side extension
// describes the same shapes in TypeBox (it cannot share this module), so the two
// schemas are the two ends of one JSON contract.
export const LocalReadParamsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export const LocalWriteParamsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export const LocalEditParamsSchema = z.object({
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
export const LocalLsParamsSchema = z.object({
  path: z.string().min(1),
});
export const LocalGlobParamsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
});
export const LocalGrepParamsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
});
export const LocalBashParamsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type LocalReadParams = z.infer<typeof LocalReadParamsSchema>;
export type LocalWriteParams = z.infer<typeof LocalWriteParamsSchema>;
export type LocalEditParams = z.infer<typeof LocalEditParamsSchema>;
export type LocalLsParams = z.infer<typeof LocalLsParamsSchema>;
export type LocalGlobParams = z.infer<typeof LocalGlobParamsSchema>;
export type LocalGrepParams = z.infer<typeof LocalGrepParamsSchema>;
export type LocalBashParams = z.infer<typeof LocalBashParamsSchema>;

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

// What the desktop POSTs back once it has run the call. `ok` is the tool's own
// success (a shell command exiting non-zero is still `ok: true` with the exit
// code in `output`); `ok: false` is reserved for a call the desktop refused or
// could not attempt (bad params, missing file, disallowed path). `output` is the
// textual evidence handed to the model.
export const DeviceResultSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});
export type DeviceResult = z.infer<typeof DeviceResultSchema>;

// The broker's reply to the pi child's /call: the result fields without the
// correlation id (the HTTP response already pairs with the request).
export type ToolCallOutcome = {
  ok: boolean;
  output: string;
  error?: string;
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
