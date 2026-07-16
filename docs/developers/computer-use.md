# Fast Computer Use

Sandi controls ordinary Windows and Chrome interfaces through the packaged MCP
servers. Native controls use Windows-MCP, page content uses Chrome DevTools MCP,
and screenshots cover interfaces with no useful semantic state. Dependent calls
belong in one `sandi_js_run`, which removes a parent-model round trip between
each observation and action.

## Configure the packaged servers

Sandi can configure both servers herself through `desktopMcp.configure`; there
is no user approval dialog. The normal configuration uses these bundled command
ids:

| Server              | Bundled command id    | Arguments    |
| ------------------- | --------------------- | ------------ |
| Windows UI          | `windows-mcp`         | none         |
| Isolated page tools | `chrome-devtools-mcp` | `--isolated` |

The Windows command always appends its fixed UI catalog after user arguments,
so a configuration cannot re-enable PowerShell, filesystem, clipboard, process,
registry, notification, or scraping tools. File and command work stays in
Sandi's existing local tools.

The Chrome default creates a temporary isolated profile. Connecting to an
existing profile is an operator choice because it exposes that profile's tabs
and authenticated sessions. Only replace `--isolated` with `--autoConnect` or a
specific debugging endpoint when the operator asks for that profile and accepts
Chrome's remote-debugging consent.

## Route and execute

| Target                                                     | Interface            |
| ---------------------------------------------------------- | -------------------- |
| Native apps, browser chrome, permission UI, and OS dialogs | Windows-MCP          |
| Page content, forms, console, and network                  | Chrome DevTools MCP  |
| Files, directories, and commands                           | Existing local tools |
| Canvas, remote desktop, games, and inaccessible custom UI  | Fresh screenshots    |

Search the relevant cached catalog, describe the exact tools, and use their live
schemas. A normal code-mode loop observes semantic state, acts, waits on a
semantic condition, and observes again to verify. Windows actions use coordinates
from the current `Snapshot`, or labels when the live schema exposes them. Chrome
actions use ids from the current page snapshot. Never reuse either after the UI
changes without observing again.

When a task crosses boundaries, switch tools at the boundary. For example, keep
form work in Chrome DevTools, use Windows-MCP for the resulting operating-system
dialog, then return to the page snapshot for verification. A `Screenshot` is the
fallback when accessibility or DOM state omits the target; take a fresh image
before acting and another after acting.

## Desktops and recovery

A turn can only reach desktops linked to the same human identity. A turn from the
desktop app uses its originating desktop. Discord and GitHub turns with several
linked desktops should call `local_list_desktops` and pass the selected id or
name instead of relying on the newest connection.

Start diagnosis with `local_mcp` using `operation: "servers"`. A missing catalog
means the server has not connected; a bounded `lastError` explains the latest
failure. Enabling and disabling a server, replacing or removing its config,
transport failure, and app shutdown close its child. An ordinary device-link
reconnect does not: the app keeps healthy stdio children and the next exact call
uses them through the restored link.

Run the app and server as the same unelevated interactive Windows user. This
keeps Windows UI Automation in the user's desktop session and makes MCP servers
descendants of the Electron app. The packaged smoke automates a virtual-desktop
round trip and a separate device-link reconnect, then confirms that `Snapshot`
still works and the same MCP child processes remain app-owned. Lock/unlock and
remote desktop reconnections still need a manual check in the target deployment:
wait for the device link, call `Snapshot`, and inspect `servers` before making one
fresh call if the transport closed. Do not replay an ambiguous mutating action.

## Packaged smoke

The real-desktop smoke is opt-in because it briefly opens an isolated Chrome
window and the Run dialog. It types only fixture markers and dismisses the dialog
without executing them. Run it from an unlocked, unelevated Windows session:

```powershell
cd app
npm run build
npm run prepare:mcp-runtime
npm run verify:mcp-runtime
npx electron-builder --win dir --publish never
$env:SANDI_COMPUTER_USE_SMOKE = "1"
$env:SANDI_COMPUTER_USE_BENCHMARK_OUTPUT = (Resolve-Path ..).Path + "\docs\developers\computer-use-benchmark.json"
npx tsx --tsconfig tsconfig.main.json scripts/verify-packaged-app-mcp.ts
```

The smoke uses the packaged Electron composition root and bundled offline
runtimes. It checks the exact Windows tool catalog, native observation and input,
Chrome page interaction, a value carried from Chrome through a Run dialog and
back, disabled-server refusal, virtual-desktop and device-link recovery, and
same-user app ownership of both stdio server processes.

## Benchmark

The smoke also measures five warm repetitions of two complete tasks. The native
task opens Run, enters a marker, and verifies it; dismissal is excluded cleanup.
The browser task fills, submits, and verifies a loopback form. The screenshot
paths use direct image observations and fixed waits; the semantic paths wait on
UI or page conditions inside one composed run.

| Task    | Path       | Median time | Parent turns | MCP calls | Screenshots | Failures |
| ------- | ---------- | ----------- | ------------ | --------- | ----------- | -------- |
| Native  | Semantic   | 4,368 ms    | 1            | 6         | 0           | 0/5      |
| Native  | Screenshot | 8,816 ms    | 5            | 7         | 3           | 0/5      |
| Browser | Semantic   | 1,376 ms    | 1            | 5         | 0           | 0/5      |
| Browser | Screenshot | 6,602 ms    | 3            | 5         | 2           | 0/5      |

These are packaged tool-path times from July 16, 2026. Each parent turn is an
executed tool phase: a fresh Node/tsx action through Sandi's runtime and desktop
broker, or a direct broker observation whose decoded image reached the harness.
Model inference, fixture reset, coordinate calibration, cleanup, and
machine-readable validation are excluded. The raw record includes every per-turn
MCP trace and all five outcomes for each path in
[`computer-use-benchmark.json`](computer-use-benchmark.json); the harness fails
if either semantic median is slower, uses as many parent turns, or adds failures.

AutoIt remains outside the baseline. It becomes useful only when a repeated,
stable application workflow cannot be operated reliably through accessibility,
DOM state, local commands, or fresh screenshots; until then it adds another
runtime and application-specific script surface without improving the general
routing path.
