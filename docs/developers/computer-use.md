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
the user's running profile. The server receives that real profile path as an
argument while its process environment remains isolated. Chrome must have
remote debugging enabled at `chrome://inspect/#remote-debugging`, and the user
must allow the connection. Generic web research does not need this server.

## Native execution model

Keep native work in one observe-act-wait-verify AutoIt script. Discover and
retain PID/HWND, then use this order:

1. Use `ControlSetText`, `ControlClick`, or `ControlCommand` with a stable
   control id.
2. Include `<SandiAutoIt.au3>` and use its scoped UIA facade for controls that
   do not expose a useful Win32 control interface.
3. Use the facade's guarded `SandiInput_*` keyboard or mouse helpers only when
   neither targeted path can perform the action.

The first-party UIA facade resolves from a validated HWND/PID root. Searches
are bounded, skip document subtrees, and match control type with AutomationId
and accessible name when those properties exist. Zero and ambiguous matches
fail with candidate identities. Invoke, toggle, select, get-value, and set-value
operations resolve the selector again before acting, so callers cannot mutate
through a stale UIA element. Chrome DevTools remains the browser DOM path.

Raw `Send`, `Mouse*`, `Call`, `Execute`, `Eval`, and native dispatch are rejected
in submitted AutoIt source. Guarded helpers own `BlockInput`, validate the
foreground HWND/PID after blocking, and revalidate before every short chunk.
Keyboard helpers also compare the focused UIA element with the requested
control. Focus or identity loss stops the remaining input rather than
redirecting it.

Guarded global fallback requires `#RequireAdmin`, which is an explicit,
on-demand elevation request. `local_autoit_run` pre-elevates its supervisor, so
the actual script inherits administrator rights without AutoIt's detached
relaunch. The user may approve or decline UAC, and Sandi must not automate that
decision. Control* and UIA scripts do not need elevation.

The supervisor captures output and exit status, enforces timeout and
cancellation, kills descendants, and releases blocked input and pressed mouse
buttons during cleanup. Windows also releases `BlockInput` when the blocking
thread exits unexpectedly.

Every submitted artifact first runs through the bundled `Au3Check` with strict
variable declarations. This catches undefined functions, variables, macros,
argument-count errors, and missing includes before AutoIt or UAC starts. Exit 1
means warnings and allows execution; syntax or checker errors stop in the
`syntax_check` phase. `Aut2Exe` is not a substitute because AutoIt's compiler
does not check syntax.

## Desktop routing and results

Every local tool accepts the optional `desktop` selector. A desktop-originated
turn defaults to that machine; a cross-surface turn with several connected
desktops must call `local_list_desktops` and choose one. The broker binds each
dispatch to the turn's abort signal.

`local_js_run` defaults `cwd` to the desktop tool root. A relative `cwd` resolves
from that root. AutoIt uses the same root as its process working directory,
while `@ScriptDir` identifies the unique persisted run artifact. Both tools
return separate bounded stdout and stderr as untrusted evidence plus runtime
version, artifact path, cwd, exit code, signal, timeout, truncation, duration,
elevation, execution phase, and syntax-check metadata.

## Verification

The normal Windows runtime gate is non-elevated and includes a real separate
AutoIt GUI fixture. It verifies background UIA value and invoke behavior,
toggle, selection, exact AutomationId selectors, duplicate-name ambiguity,
stale selector refusal, wrong PID, stale HWND, and bundled include resolution.

```powershell
npm run prepare:mcp-runtime -w app
npm run verify:mcp-runtime -w app
```

The guarded-input behavior gate is deliberately separate. It never requests
elevation and refuses unless its terminal is already elevated. Run it only when
interactive input blocking is safe:

```powershell
npm run verify:autoit-guarded-input -w app
```

That gate changes focus during chunked input, cancels multiline input while it
is active, checks that remaining input is not redirected, and sends a fresh
input probe after supervisor cleanup. The packaged release-boundary check
verifies the manifest-hashed include through a real brokered `local_autoit_run`
call:

```powershell
npm run verify:packaged-mcp -w app
```

The packaged check prepares the pinned AutoIt and Chrome payload, verifies each
staged file's size and SHA256, builds the NSIS and portable targets, relocates
and extracts both, launches the real Electron composition root, and runs
brokered JavaScript and checked AutoIt without downloading a runtime at
execution time. Its invalid AutoIt fixture proves the checker rejects the
artifact before its first mutation.
