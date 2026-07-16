# Plan 001: Add desktop-hosted MCP tools to every Sandi turn

## Intent

Let a server-side Sandi turn call MCP servers that run beside the paired desktop
and need access to that desktop's applications, files, browser state, or user
session. Reuse the existing identity-scoped desktop lease instead of exposing a
new MCP endpoint from the desktop.

The desktop app is the MCP client and process owner. Sandi forwards a small set
of operations through the existing tool broker:

```text
Pi tool or sandi_js_run
  -> single-turn loopback broker ticket
  -> authenticated device link
  -> Electron MCP host
  -> desktop-local stdio MCP server
```

## Product contract

- Pi exposes fixed `local_mcp` and `local_mcp_configure` tools. Configured MCP
  tools are discovered through search and describe operations rather than being
  registered individually in Pi.
- `local_mcp` supports server status, cached catalog search, exact tool
  description, and exact `{ serverId, toolName }` calls.
- `local_mcp_configure` supports adding, replacing, enabling, disabling, and
  removing a server through the authenticated desktop lease.
- The same operations are available as `desktopMcp` from the code-mode runtime,
  so one `sandi_js_run` can make several dependent calls without another model
  turn between them.
- Server configuration stores either an absolute external executable or a
  stable bundled command ID. Environment variable names may be inherited, but
  their values stay on the desktop.
- The Electron main process owns configuration, cached catalogs, stdio clients,
  subprocess cleanup, cancellation, and reconnect behavior. Device-link
  reconnects do not recreate healthy MCP processes.
- Search and describe use bounded cached catalogs. Calls lazily connect to the
  selected server and refresh its catalog before invocation.
- MCP results preserve multiple text and image blocks, structured content, and
  tool-level errors within the existing device result size limit. Existing
  local tools move to the same content-block result shape.
- The initial transport is stdio tools. Other MCP transports and primitives can
  be added when a desktop-affine server requires them.

## Milestones

### 1. Generalize the broker protocol

Add the two MCP broker operations and replace the legacy single-output result
with a bounded content-block result. Migrate the broker, device registry,
desktop client, existing local executors, and Pi result mapping together so the
wire contract has one version at every boundary.

Cover malformed and oversized payloads, multiple text and image blocks, JPEG,
PNG, WebP, structured content, tool-level errors, identity-scoped desktop
selection, and cancellation.

Verify with the existing broker, desktop client, executor, and local tool checks,
plus typechecking. Review the complete diff with fresh eyes, address findings,
then commit the milestone.

### 2. Add the Pi surface and Electron MCP host

Extract the reusable loopback broker client from the existing Pi extension,
then add the fixed Pi tools and `desktopMcp` runtime API. Build a focused MCP
host in the Electron main process using the stable MCP TypeScript SDK.

The host should persist validated config and catalog snapshots under Electron's
`userData`, start servers lazily, deduplicate concurrent connects, handle tool
catalog pagination and change notifications, forward cancellation, retain live
clients across calls, and close them on disable, replacement, removal, transport
failure, or app quit. Use a checked-in stdio fixture to test lifecycle behavior
without depending on Chrome or Windows-MCP.

The headless reference client should return a clear unsupported result for MCP
operations because it has no persistent host.

Verify the Pi extension, code-mode runtime, MCP host, link manager, application
build, and relevant existing checks. Review the complete diff with fresh eyes,
address findings, then commit the milestone.

### 3. Document and smoke-test the bridge

Document the operation path, ownership boundary, configuration behavior,
catalog behavior, cancellation, code-mode usage, diagnostics, and cleanup in
the existing developer guides. Keep runtime packaging details in Plan 002.

Exercise the fixture through the packaged desktop app: configure it, search and
describe from cache, call from a desktop-backed turn, verify explicit
desktop selection when several are connected, and confirm disable and removal
close the child and clean up state.

Run `npm run check`, build the app, and run `git diff --check`. Review the full
Plan 001 diff with fresh eyes, address findings, mark the plan done in the index,
and commit.

## Acceptance criteria

- Every Sandi surface can reach configured MCP tools through the current turn's
  identity-scoped desktop lease.
- Pi's MCP-facing tool count remains fixed as desktop servers are added.
- One code-mode run can discover and call several desktop MCP tools through one
  broker ticket and one live desktop client.
- Catalog discovery is cached and bounded; a call starts only its selected
  server.
- Secret values do not cross the broker or enter config, catalogs, or logs.
- Cancellation reaches an in-flight MCP request, and an interrupted mutating
  call is not retried.
- Existing local file, shell, state, screenshot, and transfer tools continue to
  pass their checks with the generalized result contract.
- `npm run check`, the Electron production build, and the installed fixture
  smoke pass.

## Review focus

Review process ownership, environment filtering, identity isolation, result
bounds, cancellation, and cleanup. Keep MCP catalog
text, schemas, stderr, and results classified as untrusted data.
