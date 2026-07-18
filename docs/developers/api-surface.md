# API Surface

The API surface lets a remote application talk to Sandi over HTTP while her
continuity (memory, skills, identity, policies, account routing, persistent Pi
sessions) stays in the server. It is the foundation for running Sandi as a
remote agent on the desktop, similar in feel to a local coding agent, but backed
by her shared brain rather than a fresh per-machine context.

Read [`surfaces.md`](surfaces.md) first: the surface/platform/shared-core split
it describes is what makes this possible. The API surface owns its HTTP intake
and delivery; everything that carries Sandi's continuity is reused unchanged
from `src/lib/...`.

## Why this exists

The Discord and GitHub surfaces authenticate Sandi (a bot token, a `gh` login)
and learn who a human is from the platform's trusted claims. A remote app
inverts that: Sandi is the server, and the caller must prove who they are. The
goal is that a household member can reach the same Sandi from a desktop app,
with the same memories and the same model account, through specific app flows
that off-the-shelf coding agents do not support.

The work is staged:

- Phase 1 (built): the server-side HTTP surface and authentication. Sandi
  reasons and runs her tools server-side, the caller is a thin client.
- Phase 2 (built): hands-local execution, where Sandi's brain stays in the
  server but file and shell tools run on the caller's machine.
- Phase 3 (built): response streaming, where the answer streams back to the
  desktop token by token as the model generates it.
- The desktop GUI app lives in the `app/` workspace and is documented in
  [`desktop-app.md`](desktop-app.md). This surface also ships a minimal headless
  reference client (`pair`, `run`, and the streaming `chat` REPL) that the app
  reuses as its client library.

## Identity and authentication

A bearer token authenticates a caller to an existing human identity. Tokens are
per device, so a lost laptop is revoked without rotating anything else.

The tokens file (default `data/config/api-tokens.json`, override with
`SANDI_API_TOKENS_PATH`) stores only hashes:

```json
{
  "version": 1,
  "tokens": [
    {
      "tokenSha256": "<sha256 of the raw token>",
      "identityId": "jess",
      "deviceId": "workstation",
      "label": "Jess workstation"
    }
  ]
}
```

The server hashes the presented bearer with SHA-256 and compares it against
every entry in constant time, so neither a match position nor the entry count
leaks through timing. The raw token is never written to disk by Sandi and never
logged. `npm run api:enroll` issues a token directly (for an operator): it
validates that the `identityId` exists in `humans.json`, appends a hashed entry
under the managed-write lock (see [`current-state.md`](current-state.md) for that
lock), and prints the raw token once. Store it on the device with
`npm run client -- login --token <T>` (no Discord round-trip needed); a token
minted against a self-hosted server needs `--url` (or `SANDI_API_URL`) too, since
`login` otherwise stores it pointed at the hosted default.

### Pairing: self-service enrollment

Household members do not run the CLI. They enroll a device themselves, with an
identity-bearing surface acting as the mediator that proves who they are:

1. The member runs `/sandi auth` on a surface that already authenticates them
   (Discord today). Because this gate mints a credential, Sandi resolves them by
   their immutable platform account id only, never a mutable username, and fails
   closed if they are not on file (a member configured without an id cannot
   enroll until an operator adds it). It then issues a one-time pairing code and
   replies privately (ephemerally) with it.
2. The member pastes that code into their desktop client, which redeems it at
   `POST /v1/auth/pair`.
3. The server validates the code, re-checks against a freshly reloaded
   `humans.json` that the bound identity still maps to a platform account (so a
   member removed after the code was issued is rejected without a server
   restart), journals a reservation, durably stores one per-device bearer token,
   marks the reservation complete, and returns the token. The client stores the
   token and uses it for every later turn.

The pairing store (`src/lib/pairing/pairing-store.ts`) is platform-neutral. An
issued code binds to the resolved `identityId`, never the surface that issued
it. Its redemption journal adds only the device credential fields needed for
transaction recovery. Because a token binds to an identity, and that identity
already carries both Discord and GitHub mappings, pairing through Discord also
connects the member's GitHub account when one is on file, with no extra step.

Codes are short-lived (10 minutes), single-token secrets. Before redemption the
pairing file stores only a SHA-256 code hash (default
`data/config/api-pairings.json`, override with `SANDI_API_PAIRINGS_PATH`). During
redemption the private pairing file temporarily journals the raw device token,
device id, and label so a crash or ambiguous HTTP response can resume with the
same credential. The journal disappears when the pairing expires or a new code
supersedes it. A code is 50 bits of Crockford base32 rendered as two readable
groups, with ambiguous letters folded on redemption so a typo of `O` for `0`
still works.

Redemption holds the pairing managed-write lock across reservation, token-file
persistence, and completion. A known failed token write rolls the reservation
back, leaving the code redeemable. If the process exits after reservation, a
retry resumes the journaled token. If it exits after token persistence, the
idempotent token write detects the existing entry and completes the same
transaction. If the response is lost after completion, the same code replays
the same token until expiry. Concurrent requests therefore persist at most one
token. The unauthenticated endpoint is also rate limited per client and
globally as a flood guard.

Each pairing failure returns a terse status and mints no token: a malformed or
unknown code is `401`, a body with no code is `400`, an identity that no longer
maps to a platform account is `403`, and exceeding the rate limit is `429`.

### Identity reuse

A token carries an `identityId`, not a fresh account. At turn time Sandi
resolves that identity to the account selected by `primaryPlatform` in
`humans.json`, and runs the turn as that participant. Records without the field
retain the Discord-first, then GitHub fallback. The API turn therefore inherits
that human's profile, instructions, personal memory arena, and per-human account
routing: one shared brain across surfaces.

The surface and the platform stay distinct, exactly as the surface contract
intends. The manifest records `surface: "api"`, while the participant `platform`
is the reused account (`discord` or `github`). No new `IdentityPlatform` value
is introduced.

Everything fails closed. A missing or malformed bearer is `401`. A valid token
whose identity is not in `humans.json`, or a human with no Discord or GitHub
mapping, is `403` before any model turn runs. Sandi never runs an unauthenticated
or unmapped turn, and never borrows another human's account.

## HTTP API (Phase 1)

The server is `node:http` (no added dependency) bound to `SANDI_API_HOST`
(default `127.0.0.1`) and `SANDI_API_PORT` (default `8787`). Start it with
`npm run start:api` (or `npm run dev:api`).

- `GET /v1/health` returns `200 { "ok": true, "surface": "api" }`. No auth.
- `POST /v1/auth/pair` redeems a pairing code (see above) for a per-device token.
  No bearer (the code is the proof). Body: `{ "code": string, "deviceId"?:
string, "label"?: string }`. On success: `200 { "surface": "api", "identityId",
"deviceId", "label", "token" }`, where `token` is the raw bearer, returned once.
  An omitted `deviceId` is generated server-side.
- `POST /v1/conversations/:conversationId/turns` requires a bearer token. Body:
  `{ "input": string, "title"?: string }`. On success: `200 { "conversationId",
"text" }` where `text` is Sandi's final Markdown reply.

Error responses are deliberately terse and leak no internal paths: `401`
(missing or invalid bearer), `403` (`identity_unmapped`), `400` (empty or
malformed body, or an invalid id segment), `413` (body over the size cap), and
`502`/`503` for provider failures (`503` for rate or quota limits). Capacity
rejections also return `503 { "error": "capacity_rejected", "reason": string }`
so callers can retry overload separately from an internal provider failure.

### Device link (Phase 2)

A desktop that wants to run a turn's file and shell work locally also holds a
link open. Both routes require the device's bearer token.

- `GET /v1/devices/link` opens a Server-Sent Events stream. The server pushes one
  `tool_call` event per proxied tool call (`data` is `{ "id", "tool", "params"
}`) and sends `: ping` comments as a heartbeat. If a turn aborts (or its
  backstop fires) while the link is still up, the server pushes a `tool_cancel`
  event (`data` is `{ "id" }`) so the desktop abandons that call instead of
  running it to completion. The stream stays open until the client disconnects; a
  second link for the same token supersedes the first.
- `POST /v1/devices/result` returns one tool result: `{ "id", "ok", "output",
"error"? }`. The call is routed back to the pending tool call by the
  authenticating token's hash, never a field in the body, so a device can only
  settle its own calls. Unknown call ids answer `404`.

### Conversation model

The client chooses a stable `conversationId` per session or thread. The
canonical id is:

```text
api:<identityId>:<deviceId>:<conversationId>
```

Each segment is validated against a strict alphabet (`^[A-Za-z0-9._-]{1,200}$`)
so two distinct inputs can never collapse to the same conversation or storage
id. The persistent Pi session is keyed by the canonical id, so reconnecting the
same device to the same `conversationId` resumes that session. Conversation
memory lives under the surface-scoped prefix
`surfaces/api/sessions/<conversationId>`.

### Turn lifecycle

A turn mirrors the GitHub surface. Each conversation has a slot in the shared
`ThreadQueue`, so only one turn runs per conversation at a time. The HTTP
response blocks on the queued turn until it completes. The turn compiles
instructions through `ContextCompiler`, calls the provider with
`accountRouting: { identityId }` and `surfaceContext: API_SURFACE_CONTEXT`, and
returns the final text. If the client disconnects, a request-scoped abort signal
is combined with the queue's signal so the in-flight turn is aborted rather than
left to burn a Pi session and write to a dead socket.

## Concurrency

This surface assumes one human runs many sessions and devices, concurrently with
Discord and GitHub. Two properties keep that safe:

- Per-conversation serialization through the `ThreadQueue`, as on every surface.
- Cross-process serialization of all writes to Sandi-managed state through the
  managed-write lock, so concurrent same-identity turns on different surfaces or
  devices cannot lose a memory or manifest update. Concurrent turns are separate
  OS processes sharing one `data/` directory, so this lock, not an in-process
  mutex, is what makes the shared brain safe under load.

## Phase 2: hands-local execution (built)

Phase 1 runs Sandi's tools server-side. Phase 2 keeps her brain, memory, and
identity in the server but runs file and shell tools on the caller's machine, so
she can work against the user's real projects. The execution model the owner
chose is that the session's workspace is the whole PC, run in bypass-permissions
mode (every operation allowed), matching how the household already runs local
agents.

### Tool gating

An api-surface turn runs pi with `--no-builtin-tools`, which disables its seven
native file and shell tools (read, write, edit, bash, grep, find, ls) because
those operate on the server's disk, the wrong machine. In their place, an
api-only extension (`pi-extension/local-exec-tools.ts`) registers nine proxy
tools (`local_read`, `local_write`, `local_edit`, `local_ls`, `local_glob`,
`local_grep`, `local_bash`, `local_js_run`, and `local_autoit_run`) under distinct
names, so pi's name-based exclusion never catches them. The flag is carried by
`SandiSurfaceContext.disableBuiltinTools`, set on `API_SURFACE_CONTEXT`. Sandi's
own extension tools (memory, skills, `sandi_js_run`, and the rest) stay
server-side and unchanged; only the proxy file and shell tools run on the
desktop.

The inline scripting tools use unique persisted artifacts and one bounded
process owner. `local_js_run` invokes the Node runtime embedded in the packaged
Electron executable through `ELECTRON_RUN_AS_NODE`; it never resolves system
Node or Bun. `local_autoit_run` invokes the manifest-verified AutoIt x64 runtime
in the desktop app's interactive session. Both capture stdout and stderr as
untrusted evidence, return structured exit and timeout metadata, and kill
descendants on cancellation or timeout.

Before any AutoIt process or elevation request, the desktop runs the exact
artifact through the manifest-verified `Au3Check` from the same pinned AutoIt
distribution. Syntax errors stop in the `syntax_check` phase without executing
the script; warnings remain untrusted evidence and execution continues within
the call's original timeout and output budgets.

The packaged AutoIt include provides bounded HWND/PID-scoped UIA operations,
atomic editor insertion, guarded visual clicks, and global-input helpers. `SandiUIA_Inspect`
returns deterministic control-view JSON with optional property filters,
node/result limits, truncation metadata, reusable action identities, and
supported UIA patterns/actions. `SandiEditor_InsertText` accepts an inspector
identity and a payload of at most 65,536 characters. It uses writable
`ValuePattern` first or one focused paste operation for TextPattern-capable Edit,
Document, and Custom controls. It never sends Enter, and the supervisor restores
the clipboard on completion, failure, timeout, or cancellation. Document
controls are visible while descendant traversal is opt-in, which keeps browser
DOM trees out of the native discovery path.
Submitted scripts may use Control*, the UIA facade, direct global input,
dynamic dispatch, or native calls. There is no
function-name policy scanner; the exact artifact passes through `Au3Check`
before execution. When the user is present and actively using the computer,
guidance prefers `SandiInput_*` with `#RequireAdmin` so the supervised elevation
path owns input release during normal completion, timeout, and cancellation.
`SandiInput_TypeText` rejects newlines; multiline editor content always uses the
atomic facade. Unattended work may use direct input without elevation or a UAC
dependency.

`SandiVisual_Click` is the last mutation route for custom-rendered surfaces. It
accepts a normalized point plus the complete observation from the preceding
window screenshot. It refuses unless the same HWND/PID is foreground and its
client rectangle, screen origin, DPI, and screenshot scale are unchanged. The
facade converts to screen pixels only after those checks, performs one left
click, and uses the existing supervisor cleanup on cancellation.

Only the builtin file and shell tools are disabled on a desktop turn.
`sandi_js_run` stays enabled and the desktop surface points its runtime entry at
the unified runtime, so a desktop turn can compose Discord, GitHub, and the other
server-side helpers in addition to its desktop `local_*` tools. File and shell
work still flows only to the desktop, because the builtin tools that would touch
the server's disk stay off and the `local_*` proxies take their place.

The same extension registers four machine-state tools that read the shape of a
desktop rather than its files: `local_list_desktops`, `local_list_monitors`,
`local_list_windows`, and `local_screenshot`. They register on the same gate as
the file and shell proxies (any turn that leased a desktop), so they are
available from every surface, including the desktop REPL. A screenshot returns a
downscaled JPEG that the proxy maps to an image block in the tool result. Window
captures use the DPI-aware client area and add a versioned `visualObservation`
to structured content with HWND/PID, active state, client rectangle, client
origin in screen pixels, DPI, output dimensions, and scale. `DeviceResult`
carries both artifacts unchanged. Capture is Windows-only today (PowerShell
with `System.Windows.Forms` for monitors, `user32` for windows and client
geometry, and `System.Drawing.CopyFromScreen` for the image, in
`client/desktop-state.ts`); other platforms refuse with a clear message.

`local_grep` accepts the Unicode Google RE2 regular-expression dialect, with a
16,384-character pattern limit. RE2 keeps matching time linear for untrusted
patterns. Backreferences and lookaround are unsupported and fail before file
traversal starts. This is intentionally narrower than JavaScript regular
expressions; callers that used those constructs must rewrite the search. File
count, file size, traversal, cancellation, and output limits still apply.

`local_list_windows` returns a JSON object with `windows`, `warnings`, and
`complete`. A window that disappears or becomes inaccessible during enumeration
adds a handle-scoped warning while usable windows remain available and
`complete` becomes false. Trimming the result to its 300-window output limit also
adds a warning. Failure of the top-level Windows enumeration refuses the call
instead of returning a misleading empty or partial result.

Every `local_*` tool (file, shell, and state alike) takes an optional `desktop`
selector, so Sandi can run any call on any of the caller's connected desktops.
`local_list_desktops` names the
candidates (an id and name per desktop, the current one marked); a selector
resolves against the leasing identity's connected desktops only, so a turn can
never reach a desktop belonging to someone else, and a selector that matches none
is a refused outcome rather than a misroute. The broker answers
`local_list_desktops` from the registry itself (it never reaches a desktop) and
resolves a selector to a same-identity routing key before it dispatches.

When a call names no desktop, the default depends on how the turn was bound. A
turn that originated on a desktop (an api-surface turn the desktop itself sent)
runs on that desktop, the machine the human is working at. A turn bound by
identity (from Discord or GitHub, with no originating device) runs on the sole
connected desktop if there is one, but refuses and asks Sandi to name a desktop
when the human has several connected, rather than silently picking the most
recently linked one. The lease carries an `originDevice` flag for this; the
api-surface lease sets it, the cross-surface lease leaves it false.

### Desktop-hosted MCP bridge

Desktop-affine MCP servers use the same lease and device link as the other local
tools. Pi exposes two fixed tools, `local_mcp` for discovery and calls and
`local_mcp_configure` for persistent changes. Adding MCP servers does not add Pi
tool definitions: Sandi searches a bounded cached catalog, describes an exact
tool, then calls it by `{ serverId, toolName }`. The headless reference client
refuses these operations because it has no persistent MCP host.

The ownership path is:

```text
Pi tool or desktopMcp
  -> per-turn loopback broker ticket
  -> identity-scoped device link
  -> Electron MCP host
  -> desktop-local stdio server
```

Electron owns the server configuration, catalog snapshots, child processes,
and MCP clients under its `userData` directory. An external command must be an
absolute path; packaged servers use a stable bundled command id. Configuration
stores environment variable names only. Inherited values are resolved on the
desktop for each start, kept out of broker traffic and persistent catalogs, and
redacted from results and errors.

Every add, replacement, enable, disable, or removal is applied by the Electron
host through the authenticated desktop lease. Configuration remains lazy: the
first exact call starts the selected server and refreshes its complete
paginated catalog. Search and describe read the cache without starting a child.
Catalog-change notifications replace the snapshot after a bounded refresh.

The Electron host retains healthy clients across turns and device-link
reconnects. Disable, replacement, removal, transport failure, and app shutdown
close the child. A turn cancellation reaches the MCP request through the broker
and aborts the desktop operation; a failed mutating request is returned as a
failure and is never retried automatically.

### Transport: SSE and a loopback broker

Hands-local needs the server to call back into the desktop mid-turn. One tool
call crosses three hops:

```text
pi child  --HTTP-->  loopback broker  --SSE-->  desktop client
          <--HTTP--                   <--HTTP--
```

- The desktop opens an outbound SSE stream (`GET /v1/devices/link`) and holds it,
  so there is no inbound path to the desktop and NAT or a firewall is not in the
  way. It authenticates with its per-device bearer token and registers in an
  in-process `DeviceRegistry` keyed by that token's hash (the opaque routing
  key), so a turn always reaches the exact token's link.
- The pi child reaches back through a per-turn loopback broker. A turn already
  runs as a child process the server spawns, and coordination already flows down
  through inherited environment variables (the delivery side-effect file and the
  stop sentinel work this way). Phase 2 adds `SANDI_TOOL_BROKER_URL` and a
  single-turn `SANDI_TOOL_BROKER_TOKEN` to that environment. The proxy extension
  POSTs each tool call to the broker; the broker, bound to `127.0.0.1` so the
  route is never reachable off-box, looks the turn up by its token and relays the
  call to the device's SSE stream, then returns the result the device POSTs back
  (`POST /v1/devices/result`) as the loopback HTTP response.

SSE (not a WebSocket) carries the server-to-desktop push. It needs no new
dependency beyond `node:http`, the result channel is a plain POST, and Phase 3
response streaming reuses the same SSE machinery. The desktop sees every file
and shell operation because it executes them, so no separate event channel is
needed.

### Routing, devices, and safety

- A turn leases a broker ticket bound to the authenticating token's hash (the
  opaque routing key) and the turn's abort signal, so a call routes to the exact
  device that asked for the turn, never to an identity in general, and never to a
  device that reused another token's `deviceId`. A second desktop for the same
  human never receives another desktop's tool calls. The lease is revoked in the
  turn's `finally`, so a broker token never outlives its turn.
- A turn is leased one device key, but any of its `local_*` calls may target a
  different desktop of the same identity by selector. The broker resolves the
  leasing identity once at lease time (from the leased key, while its link is
  live) and stores it on the binding, so a `desktop` selector resolves only among
  that identity's connected desktops. A selector that matches none (including
  another human's desktop) is a refused outcome, not a misroute. Within that
  identity, an unselected call defaults to the originating desktop, and a
  cross-surface turn that finds several connected asks Sandi to name one.
- Desktop shell calls accept a timeout of at most `600000` milliseconds (10
  minutes). The Pi tool schema and broker protocol reject larger values before
  the desktop can spawn a process, and the desktop executor applies the same cap.
- An offline device fails closed. With no link registered, the turn leases no
  broker, the proxy extension registers no tools, and the turn runs without file
  or shell access rather than touching the server. A call whose device drops
  mid-turn rejects with a device-unavailable error. An aborted turn rejects its
  in-flight calls and pushes a `tool_cancel` to the desktop, which aborts the
  matching command (killing the process tree on Windows, where signaling the
  shell wrapper alone would not). The same routing property later enables
  cross-surface flows (ask from Discord, execute on an enrolled workstation).
- With bypass-all execution the enrollment token is the entire security boundary,
  so per-device tokens and a server bound to a trusted interface carry the weight.
  The desktop caps output and runtime so one call cannot flood the model or
  wedge the link. It does not sandbox paths; pairing a desktop grants Sandi the
  reach the human already has there.

### Reference client

`src/surfaces/api/client/` is a minimal headless desktop client so the surface is
usable and verifiable end to end. Two commands write the credentials file.
`npm run client -- pair <CODE>` redeems a `/sandi auth` code (the Discord
self-service flow), and `npm run client -- login --token <T>` stores a token an
operator minted with `npm run api:enroll`, so a self-hosted user does not have to
hand-write the file. Both target the hosted surface at
`https://api.sandi.jessica.black` by default; pass `--url` (or set
`SANDI_API_URL`) to pair against a local dev server instead. Both store a
per-device token in the OS config dir
(`%APPDATA%\sandi\desktop.json` on Windows, `~/Library/Application
Support/sandi/desktop.json` on macOS, `~/.config/sandi/desktop.json` on Linux),
owner-only, resolved through the small `directories`-style helper in
`src/lib/config/platform-dirs.ts`; override the whole path with
`SANDI_DESKTOP_CONFIG`. An existing `~/.sandi/desktop.json` from before the move
is carried forward on the next client run. `npm run client -- run` holds the link
open and runs each dispatched tool call locally, reconnecting with backoff.
`npm run client -- chat` is the interactive REPL: it holds the same link, sends
each typed line as a turn, and prints the answer as it streams in (see Response
streaming below). The local executors live in `client/executors.ts`. The token
file is the human's own machine state, written with plain `fs`, never the
server's managed-write lock. The desktop GUI app in `app/` imports these same
client modules (the link loop, `sendTurn`, credentials, pairing) as its
transport; see [`desktop-app.md`](desktop-app.md).

### Response streaming

The turn POST still returns the final reply in one body (the provider collects
`pi --print` stdout and returns it whole), but the desktop no longer has to wait
for it. The answer also streams back token by token over the device link as the
model generates it, reusing the hands-local plumbing rather than adding a second
transport.

- An api-only pi extension (`pi-extension/response-stream.ts`) loads into the
  child alongside the proxy tools. It subscribes to pi's `message_update` events,
  pulls the text deltas out of each `assistantMessageEvent`, and POSTs them to the
  broker's streaming ingress (`POST /stream`) using the same per-turn token the
  tools use. A `SANDI_TURN_ID` on the child tags each delta with its turn.
- The broker relays each delta to the paired desktop over its SSE link as a
  `response_chunk` event (`DeviceRegistry.streamResponseChunk`). Unlike a tool
  call there is no reply; deltas flow one way, best-effort. A delta to a vanished
  device answers 503 so the child stops pushing, and a lost delta never fails the
  turn.
- The streamed text is a live preview; the turn POST's final body stays
  authoritative. The `chat` REPL prints deltas as they arrive and, when the turn
  settles, fills in any tail the stream missed (the child can exit before its last
  deltas flush) without re-printing what already showed. A turn id scopes each
  stream so a late straggler from a finished turn cannot bleed into the next.
- Streaming is gated on the same lease as the tools. A turn with no connected
  device leases no broker, so the extension reads no env and subscribes to
  nothing, and the response returns only over the turn body, exactly as before.

## Attachments

Sandi can take a file into a turn's context and can hand one back in her reply,
both scoped to the caller's own identity and stored server-side alongside her
other continuity.

### Store

Attachments are content-addressed under the server data dir
(`src/surfaces/api/attachments/store.ts`): a blob lands at
`attachments/<first 2 hex chars of its sha256>/<sha256>`, sharded by its own
hash prefix so one directory never accumulates every blob the server has ever
seen, with a sidecar `<sha256>.json` alongside it:

```json
{
  "hash": "…64 lowercase hex…",
  "size": 82301,
  "mimeType": "image/png",
  "name": "plot.png",
  "ownerIdentityIds": ["hopper"],
  "createdAt": "2026-07-05T12:00:00.000Z"
}
```

An upload streams to a temp file in the same shard directory while it is
hashed, so the final rename into place is a same-volume atomic move rather than
a cross-device copy, and a body over the cap (64 MiB) aborts mid-transfer
rather than after buffering the whole thing. Re-uploading bytes already on file
is a dedup no-op: the temp copy is discarded and the sidecar only gains the new
uploader, keeping whichever name and mime type were stored first. Mime types
are restricted to a short list today (`image/png`, `image/jpeg`, `image/webp`,
`image/gif`, plus `application/octet-stream` as a fallback), kept as an
exported const so widening it later is a one-line change.

A read scoped to the requesting identity returns someone else's attachment
exactly like a missing one, so a caller can never probe for another identity's
uploads by guessing a hash.

### Inbound: uploading and referencing a file

- `POST /v1/attachments` is a raw-body upload, not JSON, so a single stream can
  be hashed as it arrives rather than parsed and buffered as multipart fields.
  The `content-type` header is the mime type; a custom `x-sandi-name` header
  carries the filename (non-empty, capped at 200 characters, no path
  separator). On success: `200 { "hash", "size", "mimeType", "name" }`. Errors:
  `400 invalid_mime` or `invalid_name`, `413 too_large` or `quota_exceeded`,
  plus the usual `401`/`403` from the shared bearer auth.
- `GET /v1/attachments/:hash` streams the blob back with its stored content
  type and a `content-disposition` filename. `404 unknown_attachment` covers
  both a hash the server has never seen and one the caller does not own.
- A turn body may carry `attachments?: [{ hash, name? }]`, at most 16 refs and
  128 MiB of aggregate attachment data. Each hash uses the store's canonical
  shape (64 lowercase hex). Before the turn is queued, every ref is resolved
  against the store for the requesting identity; an unowned or unknown hash
  answers `400 { "error":
"invalid_attachment", "hash" }` (naming only the hash the caller already
  supplied, nothing else about the attachment) without leasing a queue slot or
  spawning a provider turn. Resolved refs are copied into a temp directory
  scoped to that one turn (`turn-materialize.ts`), under a sanitized filename
  (a ref's own `name` overrides the stored one; a collision between two refs is
  suffixed rather than overwritten), and the directory is removed in the turn's
  `finally` regardless of how the turn ends.

Each identity has a persistent attachment quota, 2 GiB by default. Content
deduplication stores one blob, while quota accounting charges each owner once
for that hash. Upload admission is serialized per identity and returns
`quota_exceeded` instead of evicting existing data. Conversation manifests keep
the hashes used by retained turns. A daily mark-and-sweep pass preserves those
hashes and explicitly pinned sidecars, gives newly unreferenced records a
30-day grace period, and removes expired blobs, orphan sidecars, and interrupted
staging files. Cleanup logs reclaimed bytes, deleted blobs, skipped records, and
malformed metadata. Configure these policies with
`SANDI_ATTACHMENT_QUOTA_BYTES`, `SANDI_ATTACHMENT_RETENTION_DAYS`, and
`SANDI_ATTACHMENT_CLEANUP_INTERVAL_HOURS`.

The materialized paths reach the provider as `ProviderTurnRequest.attachmentPaths`.
`pi-cli-client.ts` passes each as an `@<path>` argv token alongside the turn's
stdin-piped message: pi's print-mode message builder concatenates the piped
stdin content, each `@file`'s text (or, for an image, an image attachment on
that same message), and the first positional message into one initial prompt,
regardless of where the `@`-prefixed token appears in argv. That means an
attachment rides into the model's context without changing how `input` itself
is delivered. `verify:pi-harness` covers this against a fake pi command that
records its argv and stdin.

### Outbound desktop files

Desktop chat uses the `attach_to_reply` extension tool
(`pi-extension/attach-to-reply-tool.ts`, loaded alongside the other api-surface
extensions) takes `{ path, name? }`, where `path` is a file already on the
caller's desktop (typically one Sandi just wrote there with a `local_*` tool).
It POSTs the attachment to the broker's `/attachment` ingress using the same
per-turn token and turn id the tools and the response stream use; the broker
validates the body against `ResponseAttachmentSchema`, rejects a turn id that
does not match the lease (`409`), and relays it to the device's SSE link as a
`response_attachment` event (`DeviceRegistry.streamResponseAttachment`), mirroring
how `/stream` relays a response delta. A vanished device answers `503`, which
the tool surfaces to the model as a plain error rather than a silent drop. On a
non-desktop-chat turn, the tool directs the model to the matching
surface-specific delivery tool.

`ResponseAttachmentSchema` (`{ turnId, seq, path, name?, mimeType? }`) is its
own schema, separate from `ResponseChunk`: an attachment is a one-shot notice,
not a streamed delta, and `seq` is a per-turn counter the extension keeps
independently of the response-chunk stream's own. `desktop-client.ts` parses
the event and surfaces it through an optional `onResponseAttachment` callback
on `DesktopClientOptions`; the reference `chat` REPL prints a one-line
`[attached: <name or path>]` note when one arrives for the turn in progress.

Discord uses `attach_desktop_file_to_discord` instead. Its request names a
desktop path, optional safe filename and MIME type, optional content, and an
optional desktop selector. The broker token must belong to a Discord turn whose
lease carries a delivery callback. The broker resolves the selector only among
that identity's connected desktops, dispatches the private
`local_transfer_file` call, validates the returned bytes and metadata, then
invokes the callback for the originating Discord channel. The 4,500,000-byte
file cap leaves room for base64 and the result envelope under the 8 MiB device
result limit. File bytes never appear in model-visible tool output.

Revoked leases and cancelled turns reject the request. A disconnected desktop,
invalid path or metadata, oversized file, incomplete transfer, and Discord
upload failure return explicit errors. A successful upload records a Discord
delivery side effect so the automatic final-text post does not duplicate it.

## Files

```text
src/lib/pairing/
  pairing-store.ts              platform-neutral pairing-code store (issue/redeem)
  verify-pairing.ts             store and transaction recovery verification
  verify-pairing-transaction.ts crash, rollback, and idempotency scenarios
src/lib/identity/
  resolver.ts                   strict id resolver + reloading HumanIdentityStore
  verify-auth-resolver.ts       strict resolver, store freshness, duplicate ids
src/surfaces/api/
  index.ts                      entrypoint and lifecycle
  config.ts                     loadApiAppConfig (host, port, tokens, pairings)
  auth/
    tokens.ts                   token store, hashing, verify, reload, mint
    enroll.ts                   api:enroll CLI
    pairing.ts                  redeemPairing: the redemption domain logic
    participant.ts              identity-to-participant mapping (turn + pairing)
    rate-limiter.ts             FixedWindowLimiter (per-client + global caps)
    verify-rate-limiter.ts      limiter cap and reset verify
  api/
    conversations.ts            canonical ids and manifest builder
    delivery-instructions.ts    API delivery contract
  bot/
    api-bot.ts                  HTTP server, routing, auth, pairing, turns, device routes, attachment routes
    verify-api-bot.ts           verify harness with an injected provider
  attachments/
    store.ts                    content-addressed blob store: streamed hashing upload, dedup, identity-scoped get
    verify-attachment-store.ts  hashing, dedup, identity scoping, size cap, path layout verify
    upload-route.ts             POST /v1/attachments: header validation, streamed store, error mapping
    download-route.ts           GET /v1/attachments/:hash: identity-scoped stream-back with headers
    turn-materialize.ts         turn-body attachment refs: schema, per-turn temp-dir materialize + cleanup
    verify-attachment-routes.ts end-to-end verify against a real ApiBot: upload/download, caps, turn refs
  devices/
    protocol.ts                 hands-local + streaming wire protocol (tools, cancel, binary results, response_chunk, response_attachment)
    desktop-file-transfer.ts    bounded file-transfer schemas and Discord delivery envelope
    device-registry.ts          tracks desktop SSE links; dispatches, cancels, settles, streams, resolves identity desktops
    device-routes.ts            HTTP edge: SSE link and result POST controllers
    tool-broker.ts              loopback broker: per-turn token, tool relay, desktop selection, streaming and delivery ingress
    verify-tool-broker.ts       broker + registry round-trip, authorization, cancellation, selection, and delivery relays
  http/
    respond.ts                  shared sendJson and bearer-token parsing
    read-json-body.ts           shared bounded JSON body reader
  pi-extension/
    local-exec-tools.ts         api-only proxy tools (local_*) routed to the broker, incl. state tools + image mapping
    verify-local-exec-tools.ts  proxy routing and ok/refused/unavailable/image mapping
    response-stream.ts          api-only extension: relays response deltas to the broker
    verify-response-stream.ts   event classification, env parsing, delta POST
    attach-to-reply-tool.ts     api-only extension: attach_to_reply tool, relays an outbound attachment to the broker
    attach-desktop-file-to-discord.ts  Discord tool: transfers a leased desktop file to the current conversation
    verify-attach-to-reply.ts   env parsing, broker relay (happy/mismatch/unavailable/error), tool result shapes
  client/
    index.ts                    reference client CLI (pair | login | run | chat)
    desktop-client.ts           SSE link loop: tool dispatch, cancel, response deltas, response attachments, reconnect
    verify-desktop-client.ts    end-to-end link verify: dispatch, cancel, result-report, stream, response_attachment
    executors.ts                local file and shell implementations + state-tool routing
    desktop-file-transfer.ts    private bounded desktop file reader for Discord delivery
    verify-executors.ts         per-tool executor verify against a temp dir
    desktop-state.ts            Windows monitor/window enumeration and screenshot capture
    verify-desktop-state.ts     platform-aware state-tool verify (live on Windows, refusal elsewhere)
    turns.ts                    sendTurn + reconcileSuffix (REPL turn POST and stream reconcile, incl. attachment refs)
    response-printer.ts         renders a streamed response for the chat REPL
    verify-turns.ts             reconcile, printer, and sendTurn outcome mapping
    credentials.ts              per-device token file (owner-only, OS config dir, legacy migration)
    verify-credentials.ts       owner-only round-trip, config-path resolution, legacy migration
    pairing.ts                  client-side code redemption
    verify-pairing.ts           client redemption: success, label fallback, errors
    http.ts                     client JSON POST helper
  runtime/
    context.ts                  API_SURFACE_CONTEXT (disableBuiltinTools for hands-local)
    index.ts                    runtime barrel (server-side helpers)
src/lib/config/
  platform-dirs.ts              directories-style per-OS config/data/cache dirs
  verify-platform-dirs.ts       per-OS path resolution (Windows, macOS, Linux/XDG)
src/lib/provider/
  pi-cli-client.ts              --no-builtin-tools gating + broker and turn-id env threading + @-file attachment pass-through
src/surfaces/discord/bot/
  device-auth.ts                issueDeviceCode: the /sandi auth issuer core
  verify-device-auth.ts         issuer verify (recognized vs declined)
```

The pairing store lives under `src/lib/` (not the API surface) because two
surfaces write it: the issuing surface (Discord's `/sandi auth` handler) and the
redeeming API surface. Even though the merged host runs both in one process,
shared core must not import a surface, so the store stays in core. It binds only
an `identityId`, so it stays surface-neutral. Pairing
timestamps are stored as epoch milliseconds, parsed to numbers at the file
boundary so nothing reparses a string at use.

Configuration lives in `.env.example` under the `SANDI_API_*` keys (plus the
client-side `SANDI_API_URL` and `SANDI_DESKTOP_CONFIG`). Coverage runs as part of
`npm run check`: `verify:api-bot` proves health, auth rejection, the
unmapped-identity 403, identity routing, session reuse, token revocation, the
full pairing redemption loop, idempotent response replay, that a freshly minted
token authenticates a turn at once, and the device routes (auth, SSE open,
unknown-result 404); `verify:pairing` covers expiry, superseding, concurrency,
write rollback, and recovery at each transaction transition;
`verify:auth-resolver` covers strict resolution, identity-store freshness, and
duplicate-id rejection; `verify:api-rate-limiter` and `verify:discord-auth` cover
the limiter and the issuer. For hands-local, `verify:tool-broker` covers the
broker-to-device round-trip, device-unavailable, abort (including the
`tool_cancel` it pushes to a connected device), token revocation, desktop
discovery and same-identity selection, the origin-device default, the
ask-to-pick refusal when an unanchored turn finds several desktops, the
cross-identity refusal, and a screenshot image relaying through the broker reply; `verify:local-exec-tools`
covers the proxy extension's routing and error mapping, including mapping an image
outcome to an image content block; `verify:desktop-hands` covers identity-scoped
desktop resolution (`identityForKey`, `desktopsForIdentity`) alongside the lease
path; `verify:desktop-state` exercises the Windows enumeration and capture path
live on Windows and asserts a clear refusal on any other platform;
`verify:client-executors` covers each local file and shell executor (and the
state-tool routing), including bash cancellation; `verify:desktop-client` drives
the reference client against a fake api surface to prove it runs a dispatched
call, abandons one on `tool_cancel`, reports both outcomes, and surfaces a
`response_attachment` event through `onResponseAttachment`; and
`verify:pi-harness` proves an api turn disables builtin tools and passes the
broker env through while a default turn does neither, and that an attachment
path rides as an `@`-prefixed argv token alongside the stdin-piped message.

For attachments specifically, `verify:attachment-store` covers hashing, dedup
(including which name and mime type win), identity-scoped reads, the size cap
aborting mid-stream, and the on-disk shard layout; `verify:attachment-routes`
drives a real `ApiBot` end to end: the upload/download round trip, the 401 with
no bearer, the 404 for an unowned or unknown hash, the 413 over the size cap,
name and mime validation, and a turn body with attachment refs materializing
files under sanitized names, passing their paths to the provider, and cleaning
up its temp directory once the turn finishes; and `verify:attach-to-reply`
covers the extension's broker relay (the happy path, a turn-mismatch `409`, a
device-unavailable `503`, and an unexpected status) plus the exact tool-result
shapes for its success and its no-desktop-link refusal. `verify:tool-broker`
additionally covers the `/attachment` ingress (relay, turn mismatch, device
gone), mirroring its `/stream` coverage.
