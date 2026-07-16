# Plan 001: Add desktop-hosted MCP tools to every Sandi turn

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 734da42..HEAD -- package.json package-lock.json .env.example src/surfaces/api src/host/runtime app docs/developers`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. A mismatch
> is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `734da42`, 2026-07-15

## Why this matters

Sandi's Pi process runs on the server, while Windows-MCP, Chrome DevTools MCP,
and similar servers must run on the paired desktop to reach its UI, browser,
credentials, and files. Running those MCP servers beside Pi would control the
wrong machine. Exposing an unauthenticated desktop HTTP endpoint would add an
inbound attack surface and would bypass Sandi's identity-scoped desktop lease.

The desktop app should become the MCP client and process owner. A turn will use
the existing single-turn loopback ticket and authenticated device link to send
bounded search, describe, call, and configuration operations to that app. This
keeps process lifecycle, local environment values, and MCP sessions on the
desktop while making the tools reachable from desktop, Discord, and GitHub
turns through the same identity boundary as the current `local_*` tools.

## Current state

- `src/surfaces/api/devices/protocol.ts` owns the complete hands-local wire
  contract. Its current path is:

  ```text
  protocol.ts:15-21
  pi child  --HTTP-->  loopback broker  --SSE-->  desktop client
            <--HTTP--                   <--HTTP--
  ```

- `src/surfaces/api/devices/protocol.ts:136-164` defines `BrokerCallSchema` as a
  discriminated union of the fixed `local_*` calls. Unknown operations are
  rejected before dispatch.
- `src/surfaces/api/devices/protocol.ts:266-290` defines a result as one text
  string, one optional image, and one private attachment. MCP tool calls may
  return several text or image blocks plus `structuredContent`, so this result
  shape cannot carry a general MCP result without dropping data.
- `src/surfaces/api/devices/tool-broker.ts:182-223` mints a 256-bit, single-turn
  token bound to one desktop key, its identity, and the turn's abort signal.
  `tool-broker.ts:302-437` resolves an optional desktop selector within that
  identity and dispatches the validated call.
- `src/surfaces/api/devices/device-registry.ts:66-122` owns the outbound SSE
  links. `device-registry.ts:192-260` assigns a call ID, limits pending calls,
  sends cancellation, and rejects calls when the desktop disappears.
- `src/surfaces/api/client/desktop-client.ts:103-124` keeps the link alive and
  reconnects it. `desktop-client.ts:406-438` currently calls the fixed
  `executeLocalTool` function directly, so the Electron app cannot add a
  stateful executor without changing the shared reference client.
- `src/surfaces/api/client/executors.ts:75-117` executes the fixed filesystem,
  shell, machine-state, screenshot, and file-transfer calls. Pairing already
  grants Sandi the same local reach as a coding agent; output and time bounds
  protect the link, but paths are intentionally not sandboxed.
- `src/surfaces/api/pi-extension/local-exec-tools.ts` registers the fixed Pi
  tools only when `SANDI_TOOL_BROKER_URL` and
  `SANDI_TOOL_BROKER_TOKEN` form a valid loopback ticket. It also contains the
  HTTP client and result parser that other broker-backed Pi extensions need.
- `src/lib/pi-extension/js-run-tool.ts:91-114` spawns the code-mode child with
  `...process.env`. The child therefore inherits the single-turn broker ticket.
  `src/host/runtime/index.ts` is the unified runtime imported as
  `./sandi/runtime.ts`; it currently exports maps, Discord, events, reminders,
  todo, and GitHub helpers.
- `src/surfaces/api/config.ts:61-101` adds API-specific Pi extensions to the one
  extension graph shared by all surfaces. Each extension self-gates on the
  broker environment, which is why a Discord or GitHub turn can use desktop
  hands when its human identity has a connected desktop.
- `app/src/main/link-manager.ts` wraps the shared `runDesktopClient` and owns the
  Electron app's one device link. `app/src/main/index.ts:55-104` is the app
  composition root. The main process owns stateful services; renderers use typed
  IPC only.
- `app/src/main/settings-store.ts` provides the local precedent for a versioned,
  validated, atomic JSON store with corrupt-file quarantine. MCP configuration
  contains commands rather than UI preferences and must use its own file.
- `app/electron.vite.config.ts` bundles main-process dependencies and imported
  server source into `out/`; `app/electron-builder.yml` packages only `out/**`.
- The production MCP TypeScript SDK is `@modelcontextprotocol/sdk@1.29.0`.
  The split v2 packages are still beta as of this plan. Version 1.29 supports
  the stable 2025-11-25 protocol, stdio clients, pagination, cancellation, and
  tool-list change notifications.

The target path is:

```text
Pi local_mcp tool or sandi_js_run
  -> single-turn loopback ToolBroker ticket
  -> existing identity-scoped SSE device link
  -> Electron MCP host
  -> stdio MCP server on that desktop
```

The Sandi device protocol forwards operations, not MCP JSON-RPC frames. The
Electron host is the MCP client, completes the initialize handshake, owns each
stdio subprocess, caches its catalog, and translates MCP results into Sandi's
bounded content blocks. A device-link reconnect does not reconstruct or proxy an
MCP session on the server.

## Commands you will need

| Purpose                 | Command                                                                                          | Expected on success                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Install stable MCP SDK  | `npm install @modelcontextprotocol/sdk@1.29.0 -w app`                                            | exit 0; app manifest and lockfile updated                    |
| Typecheck               | `npm run typecheck && npm run typecheck -w app`                                                  | exit 0, no errors                                            |
| Broker checks           | `npm run verify:tool-broker && npm run verify:desktop-client && npm run verify:local-exec-tools` | exit 0; all assertions pass                                  |
| New Pi MCP checks       | `npm run verify:local-mcp-tools && npm run verify:desktop-mcp-runtime`                           | exit 0; all assertions pass                                  |
| New desktop host checks | `npm run verify:mcp-host -w app && npm run verify:link-manager -w app`                           | exit 0; all assertions pass                                  |
| App bundle              | `npm run build -w app`                                                                           | exit 0; Electron main, preload, and renderer bundles emitted |
| Full gate               | `npm run check`                                                                                  | exit 0; every root and app check passes                      |

## Suggested executor toolkit

- Use the `code-craft` skill if available for the protocol union, stateful MCP
  host, lifecycle cleanup, and tests.
- Use the `one-feature-one-file` skill if available when adding the Pi MCP
  extension and Electron MCP host. Keep the existing configuration and runtime
  hub changes to one import or export line where practical.
- Read the official stable MCP tool and transport specifications before coding:
  <https://modelcontextprotocol.io/specification/2025-11-25/server/tools> and
  <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>.
- Use the stable TypeScript SDK documentation at
  <https://ts.sdk.modelcontextprotocol.io/>. Do not follow the v2 beta import
  paths in current main-branch examples.
- Use the Chrome DevTools MCP README for the Windows smoke configuration:
  <https://github.com/ChromeDevTools/chrome-devtools-mcp>.

## Scope

**In scope** (the only existing files you should modify):

- `package.json`
- `package-lock.json`
- `.env.example`
- `src/surfaces/api/config.ts`
- `src/surfaces/api/devices/protocol.ts`
- `src/surfaces/api/devices/tool-broker.ts`
- `src/surfaces/api/devices/device-registry.ts`
- `src/surfaces/api/devices/verify-tool-broker.ts`
- `src/surfaces/api/devices/verify-desktop-hands.ts`
- `src/surfaces/api/client/executors.ts`
- `src/surfaces/api/client/desktop-client.ts`
- `src/surfaces/api/client/verify-executors.ts`
- `src/surfaces/api/client/verify-desktop-client.ts`
- `src/surfaces/api/pi-extension/local-exec-tools.ts`
- `src/surfaces/api/pi-extension/verify-local-exec-tools.ts`
- `src/host/runtime/index.ts`
- `src/host/runtime/verify-unified-runtime.ts`
- `src/host/verify-host-config.ts`
- `app/package.json`
- `app/src/main/index.ts`
- `app/src/main/link-manager.ts`
- `app/src/main/verify-link-manager.ts`
- `docs/developers/api-surface.md`
- `docs/developers/desktop-app.md`
- `docs/developers/surfaces.md`
- `plans/README.md` (status only)

**In scope** (new files and directories you may create):

- `src/surfaces/api/devices/mcp-protocol.ts`
- `src/surfaces/api/pi-extension/tool-broker-client.ts`
- `src/surfaces/api/pi-extension/local-mcp-tools.ts`
- `src/surfaces/api/pi-extension/verify-local-mcp-tools.ts`
- `src/surfaces/api/runtime/desktop-mcp.ts`
- `src/surfaces/api/runtime/verify-desktop-mcp.ts`
- `app/src/main/mcp/**`

**Out of scope** (do not touch):

- Pi provider selection, model, thinking effort, account routing, or session
  persistence. This plan changes tool reach, not inference.
- A raw or standards-compliant MCP endpoint on the Sandi server. Pi does not
  need to become an MCP client for desktop-hosted servers.
- `pi-mcp-adapter` integration. It remains an option for MCP servers that run on
  the same server as Pi, but it is not in the desktop path.
- Streamable HTTP and legacy HTTP+SSE MCP transports, OAuth, API-key storage, or
  literal secret values in desktop MCP configuration.
- MCP resources, prompts, sampling, elicitation, roots, and experimental tasks.
- Windows ODR discovery or MSIX packaging.
- Registering each discovered MCP tool as a separate Pi tool.
- Per-invocation approval prompts. Pairing already grants Sandi local shell and
  file access. Persistent server configuration requires approval because it
  adds an executable that can start in future turns.
- Changes to the headless reference client's configuration model. It should
  return a clear unsupported result for MCP calls because it has no persistent
  MCP host or approval UI.

## Git workflow

- Branch: `codex/desktop-mcp-bridge`
- Make one commit after the result/protocol migration, one after the desktop MCP
  host and Pi surface work, and one after docs and final verification. Recent
  subjects are short imperative sentences such as `Add durable delivery outbox`.
- Append the required `Co-authored-by: Codex <noreply@openai.com>` trailer to
  commits materially authored or verified by Codex.
- Do not push or open a pull request unless the operator asks.

## Steps

### Step 1: Generalize the desktop result contract and add MCP operations

Create `src/surfaces/api/devices/mcp-protocol.ts` for MCP-specific limits and
Zod schemas. `protocol.ts` should import its `LocalMcpParamsSchema` and add two
broker calls:

```ts
{ tool: "local_mcp", params: LocalMcpParamsSchema }
{ tool: "local_mcp_configure", params: LocalMcpConfigureParamsSchema }
```

Use precise discriminated unions. The read-only tool supports:

- `servers`: return configured server IDs, labels, enabled state, catalog state,
  and the last connection error without starting a server.
- `search`: require a bounded query, accept an optional server ID and a limit
  from 1 to 20, and return stable `{ serverId, toolName }` references with title
  and a short description. An empty query lists the best bounded matches.
- `describe`: require an exact server ID and tool name, and return the complete
  bounded input schema and annotations as untrusted catalog data.
- `call`: require an exact server ID and tool name plus a JSON object of
  arguments. Do not accept an opaque tool name flattened across servers.

The configuration tool supports `upsert`, `remove`, and `set_enabled` changes.
An upsert carries this public shape:

```ts
type DesktopMcpServerConfig = {
  id: string;
  label: string;
  sourceUrl?: string;
  enabled: boolean;
  command: string;
  args: string[];
  cwd?: string;
  inheritEnv: string[];
};
```

Bound IDs, names, query text, argument JSON, config arrays, and serialized
payloads. Put each limit beside its schema and test the limit. Do not permit
literal environment values or credentials. `inheritEnv` names environment
variables whose values the Electron process resolves locally after approval;
the values never enter the broker request, model context, config file, or logs.

Replace the public result's `output` plus single `image` shape with one bounded
content model used by every desktop tool:

```ts
type DeviceContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/jpeg" | "image/png" | "image/webp"; dataBase64: string };

type ToolCallOutcome = {
  ok: boolean;
  content: DeviceContent[];
  error?: string;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  attachment?: DesktopFileAttachment;
};
```

Keep `ok: false` for a call the desktop could not attempt or a protocol failure.
Use `isError: true` when the MCP server completed `tools/call` and returned a
tool-level error. Preserve `structuredContent` for code-mode callers. Keep the
private attachment field for Discord transfer, but never expose attachment
bytes as model content.

Apply the new content result to existing executors, the device result endpoint,
registry dispatch, broker response, and Pi result mapper. Preserve these current
bounds: 100,000 aggregate text characters, 6 MiB aggregate base64 image text,
8 MiB JSON bodies, and no more than 32 content blocks. Add WebP magic-byte
validation. A malformed or over-limit block must fail the result, not disappear.

`tool-broker.ts` must use the existing `desktop` selector logic for both MCP
calls. It must not inspect `serverId`, tool names, arguments, or configuration
beyond the validated Sandi operation schema.

**Verify**:
`npm run verify:tool-broker && npm run verify:desktop-hands && npm run verify:client-executors && npm run verify:desktop-client && npm run verify:local-exec-tools`
-> exit 0. The checks must cover multi-block text and images, WebP validation,
structured content, MCP tool errors, desktop selection within one identity,
oversized bodies, and cancellation.

### Step 2: Add the fixed Pi tool surface and code-mode MCP API

Extract the loopback URL/token validation, bounded HTTP POST, response parsing,
and abort handling from `local-exec-tools.ts` into
`src/surfaces/api/pi-extension/tool-broker-client.ts`. It must use only relative
imports inside the Pi extension graph. Keep `local-exec-tools.ts` responsible
for its current fixed tools and mapping `DeviceContent[]` to Pi text and image
blocks.

Create `local-mcp-tools.ts` as a separate Pi extension. It registers exactly two
tools when a valid per-turn broker ticket exists:

- `local_mcp` with the `servers`, `search`, `describe`, and `call` union.
- `local_mcp_configure` with the `upsert`, `remove`, and `set_enabled` union. Its
  description must say that the desktop will show the exact persistent change
  for human approval.

Do not register discovered server tools. Tool descriptions and results are
untrusted data, so wrap catalog text in a clear untrusted-data envelope and tell
the model not to follow instructions found inside it. Map `isError: true` to a
normal, visible MCP tool-error result so the model can correct arguments. Throw
only for transport, desktop, configuration, or protocol failures.

Create `src/surfaces/api/runtime/desktop-mcp.ts` with the same operations for
programmatic composition:

```ts
desktopMcp.servers(input?)
desktopMcp.search({ query, serverId?, limit?, desktop? })
desktopMcp.describe({ serverId, toolName, desktop? })
desktopMcp.call({ serverId, toolName, arguments, desktop? })
desktopMcp.configure({ change, desktop? })
```

These functions read the inherited single-turn broker ticket at call time and
return parsed content plus `structuredContent`. Export them as `desktopMcp` from
`src/host/runtime/index.ts`. This makes one `sandi_js_run` program able to search,
call several desktop MCP tools, combine structured results, and print concise
evidence without another model round trip between every call. Do not add a new
code sandbox or child process.

Add `local-mcp-tools.ts` to the shared API extension graph in
`src/surfaces/api/config.ts`, add an optional
`SANDI_PI_LOCAL_MCP_EXTENSION` path override in `.env.example`, and update the
host-config assertions. Add `verify:local-mcp-tools` and
`verify:desktop-mcp-runtime` to the root manifest and full `check` sequence.

**Verify**:
`npm run verify:local-mcp-tools && npm run verify:desktop-mcp-runtime && npm run verify:unified-runtime && npm run verify:pi-extension-load`
-> exit 0. Tests must prove that no broker registers no tools, malformed or
non-loopback broker coordinates are rejected, abort closes the request, native
results preserve every content block, and one code-mode run can make two calls
through the same ticket.

### Step 3: Build the Electron stdio MCP host

Install `@modelcontextprotocol/sdk@1.29.0` in the `app` workspace. Create focused
modules under `app/src/main/mcp/` for config storage, catalog storage, MCP client
lifecycle, search, result conversion, and the composite desktop executor. Do not
put the host in the renderer or preload. Add `verify:mcp-host` to the app
manifest and its `check` sequence.

Persist config at `join(app.getPath("userData"), "mcp.json")` with this top-level
shape:

```json
{
  "version": 1,
  "servers": {
    "chrome-devtools": {
      "id": "chrome-devtools",
      "label": "Chrome DevTools",
      "sourceUrl": "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      "enabled": true,
      "command": "cmd.exe",
      "args": [
        "/c",
        "npx",
        "-y",
        "chrome-devtools-mcp@1.6.0",
        "--no-usage-statistics",
        "--no-performance-crux"
      ],
      "inheritEnv": ["SystemRoot", "PROGRAMFILES"]
    }
  }
}
```

Use the settings-store pattern for schema validation, atomic temp-file rename,
and corrupt-file quarantine. Store validated catalog snapshots separately under
`join(app.getPath("userData"), "mcp-catalogs")`; do not mix generated schemas
into the human-approved config. Never persist or log inherited environment
values.

The host lifecycle is:

1. Load config and bounded catalog snapshots at app startup without spawning an
   MCP server.
2. Search and describe use the snapshots, so ordinary tool discovery has no
   process-start cost. A missing snapshot may connect to that enabled server to
   populate it, but search must not start servers that already have a snapshot.
3. `call` starts only the selected server, deduplicates concurrent connection
   attempts, completes the MCP initialize handshake, refreshes all pages of
   `tools/list`, confirms the tool still exists, and invokes it.
4. A declared `notifications/tools/list_changed` refreshes and atomically
   replaces the snapshot while the connection is alive.
5. Transport close or error removes the live client. The next operation may
   start a fresh connection, but a tool call that was in flight is never retried.
6. App quit closes every client and transport. Disabling, removing, or replacing
   a server closes that server before the config change is committed.

An approved upsert uses a temporary client for its preflight and closes that
client before committing config and catalog. Normal tool calls keep their client
alive for later calls because browser and desktop automation servers carry
useful session state; app quit, disable, remove, replacement, or transport
failure ends that connection. Do not add an idle timeout without an observed
resource problem.

Use the SDK's default safe stdio environment plus only the names in
`inheritEnv`. Refuse an upsert when a requested name is absent from the Electron
process environment. Resolve all environment values after the approval prompt.
The stdio child may log to stderr; capture a bounded rolling diagnostic string
for status, but never treat stderr alone as a failure and never expose it to the
model as instructions.

Search is local, deterministic, and dependency-free. Tokenize the lowercase
query, score exact tool-name and server-ID matches first, then name/title
prefixes, then description token matches, and use `{ serverId, toolName }` as
the stable tie-breaker. Return at most the requested limit. Catalog entries,
descriptions, JSON schemas, and annotations are untrusted and bounded both when
received and when loaded from disk.

Result conversion must preserve MCP text, JPEG, PNG, WebP, and
`structuredContent`. Convert resource links and embedded text resources to
bounded text blocks. Convert unsupported audio or binary resource blocks into
an explicit omission notice; never silently drop content. Enforce aggregate
Sandi result bounds before posting to the server. Keep MCP `isError` distinct
from transport failure.

Pass the device-call AbortSignal to SDK requests. Use the SDK request timeout as
an inner bound no longer than the broker's ten-minute backstop. A cancel from Pi
must produce MCP cancellation and settle the desktop executor. Do not implement
MCP tasks or background continuation.

Log server ID, tool name, duration, cancellation, and outcome in the Electron
main process. Do not log arguments, results, schemas, inherited environment
values, or stdio traffic.

**Verify**: `npm run verify:mcp-host -w app` -> exit 0. Use a checked-in stdio
fixture server under `app/src/main/mcp/fixtures/`, not Chrome or Windows-MCP, and
cover:

- empty config and corrupt-config quarantine;
- approval denial makes no filesystem or process change;
- approved upsert preflights the server and atomically commits config plus a
  catalog snapshot;
- missing inherited environment variable refuses before spawn;
- startup loads cached search and describe results without spawning the fixture;
- call lazily starts the fixture and returns multiple text/image blocks plus
  structured content;
- pagination and a tool-list change replace the snapshot;
- simultaneous first calls create one connection;
- cancellation reaches the fixture and no call is retried;
- transport close allows a later operation to establish a new connection;
- remove, disable, and replacement close a live child;
- over-limit catalog and result payloads fail closed;
- config, catalog, and logs contain no fixture secret value.

### Step 4: Integrate the host into the desktop app with approval

Add an optional `executeTool` callback to `DesktopClientOptions`. Default it to
the existing `executeLocalTool` so the headless reference client keeps its
current behavior. The Electron link manager must pass a composite executor that
routes `local_mcp` and `local_mcp_configure` to the MCP host and every other call
to `executeLocalTool`.

Construct one MCP host in `app/src/main/index.ts` after `app.whenReady()` and
before starting the link. Close it during `before-quit`. The host and its child
processes must survive device-link reconnects; the link is transport reachability,
not MCP process ownership.

For every configuration mutation, call `dialog.showMessageBox` before spawning
or writing anything. Parent the prompt to the chat window when available. Show:

- operation and server ID;
- label and source URL;
- exact command, arguments, and working directory;
- inherited environment variable names, without values;
- whether the change adds, replaces, enables, disables, or removes a persistent
  executable configuration;
- a direct warning that the server receives Sandi's desktop permissions and its
  tool results are sent to Sandi's server-side model.

Approval authorizes that one exact proposal. If the user denies it, return a
normal denied outcome and change nothing. For an approved upsert, probe and list
the server before committing. If probe fails, return the diagnostic and leave
the prior config and catalog intact.

The headless reference client has no approval UI or persistent MCP host. Its
default executor must return `ok: false` with "desktop MCP requires the Sandi
desktop app" when it receives either MCP operation.

**Verify**:
`npm run verify:link-manager -w app && npm run verify:desktop-client && npm run build -w app`
-> exit 0. The link-manager check must prove the custom executor is used, link
restart does not recreate the host, and stop aborts in-flight dispatch. Inspect
the Electron main bundle and confirm it contains the SDK implementation rather
than an unresolved runtime import.

### Step 5: Document and smoke-test Chrome and Windows MCP

Update `docs/developers/api-surface.md` with the operation path, result content
shape, identity and desktop selection, cancellation, and why the server does not
expose an MCP endpoint. Update `docs/developers/surfaces.md` to state that an
identity-bound turn from any surface can reach configured MCP tools on its
desktop. Update `docs/developers/desktop-app.md` with:

- config and cache locations;
- lazy process and catalog behavior;
- the exact approval boundary and the no-secret-values rule;
- status, search, describe, call, and code-mode examples;
- the Chrome DevTools MCP pinned config from Step 3;
- a Windows-MCP example using `uvx windows-mcp serve` after installing its
  documented prerequisites;
- how to update or remove a configured server through Sandi;
- diagnostics and cleanup after a failed server start.

For Chrome, document that the server can inspect and modify all data in its
browser instance. Keep `--no-usage-statistics` and `--no-performance-crux` in
the recommended config. Use an exact package version; updating it is another
approved config replacement. The optional `--autoConnect` path exposes an
existing Chrome profile and requires Chrome's own remote-debugging consent, so
present it as a deliberate choice, not the default.

Run a manual installed-app smoke on Windows:

1. Ask Sandi to configure the pinned Chrome server and deny the first prompt.
   Confirm no config, catalog, or child process appears.
2. Repeat and approve. Confirm the catalog is cached and the child exits when
   the probe completes.
3. Ask Sandi to search for page navigation, describe the selected tool, open a
   non-sensitive page, and take a screenshot. Confirm the result reaches the
   model without a server-side Chrome process.
4. Restart Sandi. Search the cached Chrome catalog and confirm Chrome MCP is not
   spawned until a call.
5. From a mapped Discord turn, call one Chrome tool on the connected desktop.
   With two desktops connected, omit `desktop` and confirm the broker asks Sandi
   to select one instead of guessing.
6. Configure Windows-MCP with `uvx windows-mcp serve`, search its catalog, and
   execute one harmless UI-state call. Confirm the process runs under the
   desktop app, not beside Pi.
7. Disable both servers and confirm their child processes close. Remove them and
   confirm config and catalog entries disappear.

**Verify**: `npm run format && npm run check` -> exit 0. Then run
`git diff --check` -> exit 0 and no whitespace errors.

## Test plan

- Extend `src/surfaces/api/devices/verify-tool-broker.ts` for MCP routing,
  identity isolation, multi-desktop refusal, result contents, and cancellation.
- Extend `src/surfaces/api/client/verify-desktop-client.ts` for injected
  execution, multi-block result posting, malformed content, and abort.
- Extend `src/surfaces/api/client/verify-executors.ts` and
  `src/surfaces/api/pi-extension/verify-local-exec-tools.ts` so every existing
  local tool still maps to the generalized content contract.
- Add `verify-local-mcp-tools.ts` for Pi registration, broker validation,
  operation parameter shapes, untrusted-data wrappers, and result mapping.
- Add `src/surfaces/api/runtime/verify-desktop-mcp.ts` for programmatic search,
  multiple calls, structured content, and absent-broker behavior.
- Add `app/src/main/mcp/verify-mcp-host.ts` plus a real stdio fixture for config,
  catalog, lifecycle, pagination, change notifications, calls, cancellation,
  limits, and secret non-retention.
- Extend `app/src/main/verify-link-manager.ts` for composite execution and link
  lifecycle.
- Run the full `npm run check` gate after targeted tests pass.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run build -w app` exits 0 with the stable MCP SDK bundled.
- [ ] Pi exposes only the fixed `local_mcp` and `local_mcp_configure` tools,
      regardless of how many desktop MCP servers are configured.
- [ ] `sandi_js_run` can search and call desktop MCP tools through
      `desktopMcp` using the current turn's broker ticket.
- [ ] Search and describe use a bounded cached catalog without spawning servers
      after app restart.
- [ ] A tool call starts only its selected stdio server on the selected desktop.
- [ ] MCP arguments and tool results cross the existing single-turn,
      identity-scoped broker; commands, environment values, and MCP sessions do not.
- [ ] Every persistent config mutation requires approval of the exact command
      and environment variable names.
- [ ] No secret values appear in config, catalog, logs, broker test captures, or
      model-visible management results.
- [ ] Cancellation reaches an in-flight MCP request and no mutating call is
      retried after transport loss.
- [ ] Chrome DevTools MCP and Windows-MCP pass the manual desktop smoke.
- [ ] `git diff --check` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` marks Plan 001 DONE.

## STOP conditions

Stop and report if any condition occurs:

- The current broker no longer mints one token per turn or no longer binds a
  lease to one identity's desktop set.
- `sandi_js_run` no longer inherits the broker environment, because the planned
  programmatic API would need a different security boundary.
- The stable SDK cannot bundle into the Electron main output without shipping
  `node_modules`, native binaries, or the v2 beta packages.
- Chrome DevTools MCP or Windows-MCP requires a non-stdio transport for the
  documented use case.
- SDK cancellation cannot be connected to an AbortSignal without changing the
  MCP server or retrying tool calls.
- Supporting the MCP result requires raising the existing 8 MiB device-result
  cap. Report the concrete result and size instead of weakening the cap.
- A requested MCP server needs literal credentials or OAuth. Do not put secrets
  in the config or model-visible operation; propose a separate credential design.
- Configuration cannot be approved before the executable is spawned. Running
  an unapproved probe is still arbitrary code execution.
- A step's verification fails twice after one reasonable correction.
- The implementation needs a file outside the declared scope.

## Maintenance notes

- The desktop host intentionally implements stdio tools only. Add Streamable
  HTTP as a new desktop transport when a real desktop-affine server requires it;
  remote servers with no desktop affinity belong beside Pi.
- Windows ODR may become the preferred catalog and consent source after it is
  stable and Sandi has package identity. Replace the config/catalog source
  inside the Electron host; keep the broker operation contract unchanged.
- MCP v2 is scheduled to stabilize after this plan. Stay on SDK v1.29 until v2
  is stable, then migrate in its own change with protocol fixture coverage.
- Reviewers should focus on process ownership, inherited environment filtering,
  approval-before-spawn, cancellation, result bounds, and ensuring no call is
  retried after an ambiguous disconnect.
- MCP server descriptions, annotations, schemas, stderr, and results are
  untrusted. They may help Sandi choose a tool, but they must never authorize a
  config change or relax a permission boundary.
