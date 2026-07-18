# Computer Use

Sandi uses first-party AutoIt scripts for native Windows control and the
packaged Chrome DevTools MCP server for browser-page content. Files and commands
stay in the local file, shell, and JavaScript tools. Native Windows control has
no MCP server or persistent subprocess.

## Routing

| Target                                                     | Interface                             |
| ---------------------------------------------------------- | ------------------------------------- |
| Native apps, browser chrome, permission UI, and OS dialogs | `local_autoit_run`                    |
| Page content, forms, console, and network                  | Chrome DevTools MCP                   |
| Files, directories, and shell commands                     | Existing local tools                  |
| Plain local JavaScript                                     | `local_js_run`                        |
| Interfaces without useful controls or DOM state            | Fresh `local_screenshot` observations |

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
3. If neither targeted path can perform the action and the user is present and
   actively using the computer, use the facade's guarded `SandiInput_*`
   keyboard or mouse helpers.
4. For unattended work, direct `Send` and `Mouse*` calls may perform the global
   input without waiting for UAC. Keep the sequence short and revalidate the
   target before and after it.

The first-party UIA facade resolves from a validated HWND/PID root. Searches
are bounded, skip document subtrees, and match control type with AutomationId
and accessible name when those properties exist. Zero and ambiguous matches
fail with candidate identities. Invoke, toggle, select, get-value, and set-value
operations resolve the selector again before acting, so callers cannot mutate
through a stale UIA element. Chrome DevTools remains the browser DOM path.

Submitted AutoIt source is not filtered by function name. The exact artifact
passes through `Au3Check`, then runs under the normal process supervisor. Direct
`Send`, `Mouse*`, and `SendKeys` input is allowed for unattended work. Guarded
helpers own `BlockInput`, validate the foreground HWND/PID after blocking, and
revalidate before every short chunk. Keyboard helpers also compare the focused
UIA element with the requested control. Focus or identity loss stops the
remaining input rather than redirecting it.

When the user is present and actively using the computer, guarded global
fallback prevents their input from redirecting the action. It requires
`#RequireAdmin`, an explicit on-demand elevation request. `local_autoit_run`
pre-elevates its supervisor, so the actual script inherits administrator rights
without AutoIt's detached relaunch. The user may approve or decline UAC, and
Sandi must not automate that decision. Control*, UIA, and unattended direct
input scripts do not need elevation.

The supervisor captures output and exit status, enforces timeout and
cancellation, kills descendants, and releases blocked input and pressed mouse
buttons during cleanup. Windows also releases `BlockInput` when the blocking
thread exits unexpectedly.

Desktop Stop and `/sandi stop` cancel the owning turn, including an active
`local_autoit_run`. Cancellation terminates the current AutoIt tree and its
elevation supervisor, and the cancelled executor waits for that cleanup. The
desktop reports the owning turn as stopped, while an AutoIt timeout or nonzero
exit remains a model-visible tool result with distinct timeout and exit
metadata.

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

The runtime gate includes an end-to-end cancellation check through the desktop
turn manager, API queue, tool broker, device stream, desktop executor, and real
AutoIt process tree. It stops an active action, checks that the owner and its
descendant exit promptly, confirms that no later action occurs, and runs timeout,
ordinary-failure, and recovery turns over the same desktop link.

The guarded-input behavior gate is deliberately separate. It never requests
elevation and refuses unless its terminal is already elevated. Run it only when
interactive input blocking is safe:

```powershell
npm run verify:autoit-guarded-input -w app
npm run verify:autoit-cancellation:guarded -w app
```

These gates change focus during chunked input and cancel multiline input while
it is active. The end-to-end variant also covers guarded-input timeout cleanup,
checks the child and elevated supervisor directly, and sends fresh input through
the still-running desktop link after cancellation and timeout. The packaged
release-boundary check verifies the manifest-hashed include through a real
brokered `local_autoit_run` call:

```powershell
npm run verify:packaged-mcp -w app
```

The packaged check prepares the pinned AutoIt and Chrome payload, verifies each
staged file's size and SHA256, builds the NSIS and portable targets, relocates
and extracts both, launches the real Electron composition root, and runs
brokered JavaScript and checked AutoIt without downloading a runtime at
execution time. Its invalid AutoIt fixture proves the checker rejects the
artifact before its first mutation.
