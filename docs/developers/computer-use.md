# Computer Use

Sandi uses first-party AutoIt scripts for native Windows control and the
packaged Chrome DevTools MCP server for browser-page content. Files and commands
stay in the local file, shell, and JavaScript tools. Native Windows control has
no MCP server or persistent subprocess.

## Routing

| Target                                                     | Interface                                              |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Native apps, browser chrome, permission UI, and OS dialogs | `local_native`                                         |
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

## Typed native helpers

Use `local_native` for routine native control work. Its `inspect` action takes
one retained HWND/PID and returns controls whose identities include that window,
native HWND evidence, AutomationId, control type, accessible name, class, and
root-relative path.
Pass the returned identity unchanged to `describe`, `get_value`, `set_value`,
`insert_text`, `invoke`, `toggle`, `select`, or `wait_value`. `wait_window`
checks one retained HWND/PID for existence or closure. `visual_click` requires
the complete version 2 observation from a window screenshot and normalized
coordinates.

The desktop generates the narrow AutoIt artifact, checks it, and runs it under
the normal supervisor. Facade failures are reported as structured `no_match`,
`ambiguity`, `stale_target`, `unsupported_pattern`, `cancelled`, `timeout`, or
`verification_failure` errors. Companion files carrying values or editor text
are removed after checking and execution; cleanup failure is reported instead
of success. `set_value` reads the control back before it reports verified
success. Other mutations report `observe_next`; take another inspection, value
read, or screenshot to verify their effect.

Failed typed mutations include the safe native error code in their visible
receipt summary. The receipt does not include control names, values, candidate
text, or document content.

Use `local_autoit_run` for application research and unusual multi-step flows
that the typed action union cannot express. It remains the expert escape hatch
and accepts complete AutoIt source, so its caller owns sequencing and result
interpretation.

## Raw AutoIt execution model

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
and an identity with a root-relative control-view path. The path is tried first.
If provider order changed, the facade searches the same HWND/PID subtree within
the 256-node bound and requires exactly one match for every retained property.
A nonzero native HWND must match but is never trusted without the semantic
properties. Zero is retained explicitly for provider controls without a native
HWND. A recycled root, PID mismatch, changed identity, ambiguous match, or
truncated search fails before mutation. Calls without an inspector path remain
selectors, so empty properties are wildcards and zero or multiple matches fail.

`SandiEditor_InsertText(hwnd, pid, automationId, controlType, name, text,
className="", path="", nativeHwnd=-1)` is the no-submit editor facade. It
requires the exact focused identity, normalizes CR/LF variants to CRLF, caps the
normalized payload at 65,536 characters, and uses one five-second operation
budget. A writable
`ValuePattern` receives one `SetValue`; otherwise only a focused Edit, Document,
or Custom control with `TextPattern` may take the single paste path. UIA
`TextPattern` is read-only, so it proves text capability but never performs the
mutation. The paste path snapshots and restores all clipboard formats through
the AutoIt supervisor, including failure, timeout, and cancellation cleanup.
Focus loss fails the call instead of sending more input elsewhere.

The facade never emits Enter. Submission is a separate retained-button invoke
or explicit `SandiInput_PressKey(..., "{ENTER}")` call. `SandiInput_TypeText`
rejects CR and LF and must not be used for multiline editors or chat composers.

### Action receipts

Native mutations use one versioned action receipt. The local tool's `ok` field
reports whether the desktop transport accepted and ran the call. It does not
report whether the native action reached its intended postcondition. That state
is in `structuredContent.actionReceipt`:

```json
{
  "version": 1,
  "action": "set-value",
  "method": "uia-value-pattern",
  "target": {
    "pid": 1234,
    "hwnd": "5678",
    "control": { "kind": "uia-path", "path": "0/2" }
  },
  "observation": {
    "status": "fresh",
    "observedAt": "2026-07-18T18:00:00.000Z"
  },
  "execution": {
    "status": "completed",
    "result": { "status": "succeeded" }
  },
  "verification": {
    "status": "succeeded",
    "basis": "post-action",
    "observedAt": "2026-07-18T18:00:01.000Z"
  },
  "cleanup": { "status": "not-required" }
}
```

`action` and `method` are bounded tokens. The target contains the retained PID,
HWND, and an optional root-relative UIA path. The schema rejects extra fields,
so values, selected text, clipboard data, credentials, and document contents do
not belong in a receipt.

Execution has four states. `not-started` records refusal, ambiguity, a stale
target, or an unsupported operation. `completed` records whether the mutation
call returned success or failure. `partial` records a known partial action.
`unknown` covers cancellation, timeout, or transport failure and requires
`next: "observe"`; callers must observe before retrying. A completed action may
leave verification to the caller with `reason: "caller-observation-required"`.
This is useful when invoke closes the observed control or a visual click needs a
separate state observation.

Cancellation or timeout cannot produce a completed receipt from the interrupted
call alone. A later observation may construct a completed receipt only with an
`interruption` naming the cancellation or timeout, completion evidence set to
`post-interruption-observation`, and successful verification based on
`post-interruption` observation.

Typed helpers build and parse the contract with `buildActionReceipt` and
`parseActionReceipt` from `src/surfaces/api/devices/action-receipt.ts`.
`local_autoit_run` scripts emit the same receipt as one bounded line:

```autoit
#include <SandiAutoIt.au3>
SandiActionReceipt_Emit('{"version":1,"action":"invoke","method":"uia-invoke-pattern","target":{"pid":1234,"hwnd":"5678","control":{"kind":"uia-path","path":"0/2"}},"observation":{"status":"fresh","observedAt":"2026-07-18T18:00:00.000Z"},"execution":{"status":"completed","result":{"status":"succeeded"}},"verification":{"status":"not-performed","reason":"caller-observation-required"},"cleanup":{"status":"not-required"}}')
```

The runtime removes that marker line from stdout, validates the JSON, and adds
the parsed receipt to structured content. Other stdout remains untrusted
evidence. Missing receipts are allowed for exploratory scripts. Malformed or
multiple receipts are action errors. Human-readable action summaries come from
the parsed receipt.

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
  "version": 2,
  "capturedAtMs": 1784400000000,
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

The typed helper accepts the observation for 10 seconds after `capturedAtMs`.
It then calls the facade, which checks the same HWND/PID, foreground window,
client rectangle, screen origin, DPI, and screenshot scale before converting
the normalized point to a physical screen pixel. A moved or resized window, DPI
transition, focus loss, recycled handle, inconsistent scale, or out-of-bounds
point refuses the click. Elevated calls also hold `BlockInput`; unelevated calls
are limited to unattended work and still revalidate immediately before the
single click. Never
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

Desktop Stop and `/sandi stop` cancel the owning turn, including active
`local_native` and `local_autoit_run` calls. Cancellation terminates the current
AutoIt tree and its elevation supervisor. The cancelled executor waits for that
cleanup. The desktop reports the owning turn as stopped, while an AutoIt timeout or nonzero
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

The normal Windows runtime gate is non-elevated. It verifies the bundled AutoIt
include and facade error behavior without launching an interactive window.
`npm run verify:native-automation` covers generated sources, typed result
parsing, action receipts, and every typed facade action. Synthetic desktop-state
checks cover DPI conversion, stale observations, focus loss, HWND/PID recycling,
bounds, screenshot scale, and cancellation without interacting with the active
desktop session.

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
