# Computer Use

Sandi uses first-party AutoIt scripts for native Windows control and the
packaged Chrome DevTools MCP server for browser-page content. Files and commands
stay in the local file, shell, and JavaScript tools. Native Windows control has
no MCP server or persistent subprocess.

## Routing

| Target                                                     | Interface                                              |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Native apps, browser chrome, permission UI, and OS dialogs | `local_autoit_run`                                     |
| Page content, forms, console, and network                  | Chrome DevTools MCP                                    |
| Files, directories, and shell commands                     | Existing local tools                                   |
| Plain local JavaScript                                     | `local_js_run`                                         |
| Interfaces without useful controls or DOM state            | Guarded visual fallback from a fresh window screenshot |

Chrome uses the bundled `chrome-devtools-mcp` command with `--autoConnect` for
the user's running profile. The server receives that real profile path as an
argument while its process environment remains isolated. Chrome must have
remote debugging enabled at `chrome://inspect/#remote-debugging`, and the user
must allow the connection. The MCP host starts the server on the first exact
browser call and disconnects it after 30 idle seconds, which removes Chrome's
automation banner while leaving remote debugging and the server's enabled
configuration unchanged. A later call reconnects automatically. Generic web
research does not need this server.

## Native execution model

Keep native work in one observe-act-wait-verify AutoIt script. Browser content
uses the DOM first. For other surfaces, discover and retain PID/HWND, then use
this order:

1. Use `ControlSetText`, `ControlClick`, or `ControlCommand` with a stable
   control id.
2. Include `<SandiAutoIt.au3>` and use its scoped UIA facade when no useful
   native control API exists.
3. Use `SandiEditor_InsertText` when the retained editor identity supports safe
   native or atomic insertion.
4. Use `SandiVisual_Click` only when DOM, native controls, UIA, and safe editor
   insertion cannot perform the mutation.
5. If another narrow keyboard or pointer fallback is required and the user is
   actively using the computer, use the facade's guarded `SandiInput_*`
   keyboard or mouse helpers.
6. For unattended work, direct `Send` and `Mouse*` calls may perform the global
   input without waiting for UAC. Keep the sequence short and revalidate the
   target before and after it.

The first-party UIA facade resolves from a validated HWND/PID root.
`SandiUIA_Inspect` walks the control view in breadth-first provider order and
returns structured JSON from that root without a desktop-wide enumeration. Its
optional exact filters cover AutomationId, control type, accessible name, and
class. Defaults limit traversal to 64 nodes and output to 32 elements; hard
limits are 256 nodes and 128 results. The result reports both limits,
visited/matched/returned counts, and separate node and result truncation flags.

Each inspected element includes AutomationId, numeric and named control type,
accessible name, class, native HWND when present, supported patterns/actions,
and an identity with a root-relative control-view path. Describe, invoke,
toggle, select, get-value, and set-value accept those identity fields and
resolve the element again before acting. Calls without an inspector path keep
the existing zero-match and ambiguity failures. A stale/recycled HWND, PID
mismatch, changed path, or changed identity fails instead of selecting a nearby
element.

`SandiEditor_InsertText(hwnd, pid, automationId, controlType, name, text,
className="", path="")` is the no-submit editor facade. It requires the exact
focused identity, normalizes CR/LF variants to CRLF, caps the normalized payload
at 65,536 characters, and uses one five-second operation budget. A writable
`ValuePattern` receives one `SetValue`; otherwise only a focused Edit, Document,
or Custom control with `TextPattern` may take the single paste path. UIA
`TextPattern` is read-only, so it proves text capability but never performs the
mutation. The paste path snapshots and restores all clipboard formats through
the AutoIt supervisor, including failure, timeout, and cancellation cleanup.
Focus loss fails the call instead of sending more input elsewhere.

The facade never emits Enter. Submission is a separate retained-button invoke
or explicit `SandiInput_PressKey(..., "{ENTER}")` call. `SandiInput_TypeText`
rejects CR and LF and must not be used for multiline editors or chat composers.

## Desktop activity and global input

Call `local_desktop_activity` immediately before choosing a global keyboard or
pointer fallback. It reads the current Windows session lock state, the age of
the last session-local keyboard or mouse input, and the number of interactive
user sessions. The result exists only for that tool call. It contains no user
identity, application usage, input content, or activity history.

An observation is fresh for five seconds. Input at most 15 seconds old is
`active`; input at least five minutes old is `idle`. The interval between those
thresholds is `unknown`. Last-input age is capped at 24 hours and the structured
result marks when the reported age is a lower bound. A stale or unavailable
observation, or any count other than one interactive session, is also `unknown`.

| Activity  | Global input behavior                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `active`  | Use guarded input after targeted native and UIA actions fail.                                                                       |
| `idle`    | Use direct input only when the user explicitly requested unattended work. Otherwise ask.                                            |
| `locked`  | Do not send global input. Wait for unlock or ask the user.                                                                          |
| `unknown` | Ask. Guarded input is acceptable only when the requested action is already authorized and the foreground target can be revalidated. |

Activity never proves who is at the keyboard and does not authorize an action.
Prefer targeted native or UIA operations in every state.

## Guarded visual fallback

A window `local_screenshot` captures the target client area, not the outer
frame. Its `structuredContent.visualObservation` is the only coordinate
contract accepted by the visual facade:

```json
{
  "version": 1,
  "target": { "hwnd": "12345", "pid": 678 },
  "active": true,
  "clientRect": { "x": 0, "y": 0, "width": 1280, "height": 720 },
  "clientOriginScreen": { "x": -1280, "y": 40 },
  "dpi": 144,
  "screenshot": {
    "width": 640,
    "height": 360,
    "scaleX": 0.5,
    "scaleY": 0.5
  }
}
```

The contract comes from `GetClientRect`, `ClientToScreen`, and
`GetDpiForWindow` under per-monitor DPI awareness. Public click coordinates are
normalized to `[0,1)`. Convert a screenshot pixel to normalized form with
`x / screenshot.width` and `y / screenshot.height`, then pass every observation
field unchanged:

```autoit
If Not SandiVisual_Click($hWnd, $iPid, $nX, $nY, $bActive, _
        $iClientX, $iClientY, $iClientWidth, $iClientHeight, _
        $iOriginX, $iOriginY, $iDpi, $iScreenshotWidth, $iScreenshotHeight) Then Exit 30
```

The facade checks the same HWND/PID, foreground window, client rectangle,
screen origin, DPI, and screenshot scale before converting the normalized point
to a physical screen pixel. A moved or resized window, DPI transition, focus
loss, recycled handle, inconsistent scale, or out-of-bounds point refuses the
click. Elevated calls also hold `BlockInput`; unelevated calls are limited to
unattended work and still revalidate immediately before the single click. Never
retain the screen pixel. After each click, take a new window screenshot and
verify the rendered result before another action.

This fallback is limited to one left click in a custom-rendered client area. It
does not include image matching, application adapters, drag, scrolling, typing,
or a sequence planner.

## Refusal and confirmation boundaries

- Refuse visual input in anti-cheat-sensitive software and online competitive
  games. Offline game automation still requires the user's explicit request and
  a verifiable target state.
- Require confirmation immediately before an economy-affecting action such as a
  purchase, trade, auction, wager, or irreversible inventory change. Refuse if
  the amount, recipient, or resulting state cannot be reobserved.
- Refuse visual input through a remote desktop when the nested target's HWND/PID
  cannot be retained locally. The outer remote-desktop window is not proof of
  the nested application's identity.
- Refuse visual fallback for security, credential, permission, UAC, and secure
  desktop dialogs. The user must handle those prompts, or automation must use a
  semantic OS interface that identifies the exact control.
- Require confirmation immediately before destructive actions. Reobserve the
  exact target and consequence after the action; if either cannot be verified,
  refuse the mutation.
- Refuse mutation on any surface whose post-action state cannot be observed
  reliably. A successful input call is not evidence that the intended state
  changed.

Document controls are returned, so Notepad's `Text editor` remains discoverable,
but their descendants are excluded by default and counted in
`documentSubtreesSkipped`. `includeDocumentChildren` is an explicit opt-in for
native document content. Do not enable it for Chrome or another browser;
Chrome DevTools remains the browser DOM path.

Submitted AutoIt source is not filtered by function name. The exact artifact
passes through `Au3Check`, then every AutoIt artifact runs under the process
supervisor. Direct `Send`, `Mouse*`, and `SendKeys` input is allowed for
unattended work. Guarded helpers own `BlockInput`, validate the foreground
HWND/PID after blocking, and revalidate before every short chunk. Keyboard
helpers also compare the focused UIA element with the requested control. Focus
or identity loss stops the remaining input rather than redirecting it.

When the user is present and actively using the computer, guarded global
fallback prevents their input from redirecting the action. It requires
`#RequireAdmin`, an explicit on-demand elevation request. `local_autoit_run`
pre-elevates its supervisor, so the actual script inherits administrator rights
without AutoIt's detached relaunch. The user may approve or decline UAC, and
Sandi must not automate that decision. Control*, UIA, and unattended direct
input scripts do not need elevation.

The supervisor captures output and exit status, enforces timeout and
cancellation, kills descendants, restores an editor operation's saved clipboard
formats, and releases blocked input, modifier keys, and mouse buttons through
one cleanup path. Windows also releases `BlockInput` when the blocking thread
exits unexpectedly.

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

The normal Windows runtime gate is non-elevated and launches Notepad plus a
separate AutoIt GUI fixture. It verifies discovery of Notepad's `Text editor`,
default and opt-in document traversal, valid deterministic JSON, filters, bounds
and truncation, identity reuse across every facade action, background UIA value
and invoke behavior, toggle, selection, duplicate-name ambiguity, stale selector
refusal, wrong PID, stale HWND, and bundled include resolution.

The same gate launches a custom-rendered window for the visual fallback. It
checks 96 and synthetic mixed-DPI conversion, stale movement and resizing, DPI
change, focus loss, HWND/PID recycling, bounds, screenshot scale, one guarded
click, cancellation cleanup, and a fresh screenshot showing the rendered state
change.

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
