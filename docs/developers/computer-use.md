# Computer Use

Sandi uses first-party AutoIt scripts for native Windows control and the
packaged Chrome DevTools MCP server for browser-page content. Files and commands
stay in the local file, shell, and JavaScript tools. Native Windows control has
no MCP server or persistent subprocess.

## Routing

| Target | Interface |
| --- | --- |
| Native apps, browser chrome, permission UI, and OS dialogs | `local_autoit_run` |
| Page content, forms, console, and network | Chrome DevTools MCP |
| Files, directories, and shell commands | Existing local tools |
| Plain local JavaScript | `local_js_run` |
| Interfaces without useful controls or DOM state | Fresh `local_screenshot` observations |

Chrome uses the bundled `chrome-devtools-mcp` command with `--autoConnect` for
the user's running default profile. Chrome must have remote debugging enabled at
`chrome://inspect/#remote-debugging`, and the user must allow the connection.
Generic web research does not need this server.

Native work should fit in one AutoIt script: discover and retain PID/HWND, act
through `ControlSetText`, `ControlClick`, or `ControlCommand`, wait on the real
state change, verify it, and print concise evidence. Modern controls may require
an audited task-local UI Automation include. Sandi does not bundle a UIA facade
because the available UDF families are large and have incompatible constants
and maintenance paths.

Global `Send` and mouse input are the last fallback. Each short chunk must first
revalidate its target, register exit cleanup, and successfully call
`BlockInput(1)`. It must call `BlockInput(0)` immediately afterward and recheck
state before another chunk. Current Windows versions normally require elevation
for input blocking, so an unelevated failure refuses the global action. Sandi
must not request elevation unless the user authorized it.

## Desktop routing and cancellation

Every local tool accepts the optional `desktop` selector. A desktop-originated
turn defaults to that machine; a cross-surface turn with several connected
desktops must call `local_list_desktops` and choose one. The broker binds each
dispatch to the turn's abort signal. Cancellation or timeout kills the runtime
process and its descendants.

`local_js_run` defaults `cwd` to the desktop tool root. A supplied relative
`cwd` resolves from that root. AutoIt runs with the same root as its process
working directory, while `@ScriptDir` names the unique persisted run artifact.
Both tools return separate bounded stdout and stderr as untrusted evidence plus
runtime version, artifact path, cwd, exit code, signal, timeout, truncation, and
duration metadata.

## Packaged verification

Run the release-boundary check on Windows x64:

```powershell
npm run verify:packaged-mcp -w app
```

It prepares the pinned AutoIt and Chrome payload, verifies every staged file's
size and SHA256, builds the NSIS and portable targets, relocates and extracts
both, launches the real Electron composition root, and runs brokered JavaScript
and AutoIt through the packaged app without a runtime download. The focused
runtime checks also cover syntax and nonzero exits, bounded output, timeout,
cancellation, and descendant cleanup. Native interaction with third-party apps,
UAC prompts, locked sessions, and remote-desktop reconnection remain manual
checks because release automation cannot safely mutate those interfaces.
