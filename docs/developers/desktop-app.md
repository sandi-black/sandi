# Desktop App

The desktop app in `app/` puts Sandi's sprite in a borderless, transparent,
always-on-top window on the desktop; clicking her opens a popover chat with
sessions, streaming replies, attachments, and a message queue. It is an
Electron app whose main process imports the API surface's client modules
(`src/surfaces/api/client/`) directly as TypeScript source, so the device
link, turn sending, credentials, and pairing are the same code the headless
reference client runs.

Read [`api-surface.md`](api-surface.md) first for the server side: pairing,
the device link, hands-local execution, response streaming, and attachments
are all documented there. This page covers what the app adds on top.

## Layout and workspace

The repo is an npm workspace with `app/` as its one member. One root
`npm install` covers both packages and hoists shared dependencies (one zod
across the `@sandi-server` import boundary). The server's own installs scope
themselves with `--workspaces=false` (Dockerfile and the root CI job) so the
server image and root check never pull the Electron tree.

- `app/src/main/`: the Electron main process. The only place server source is
  imported (via the `@sandi-server` alias to `../src`). Owns the windows, the
  tray, the device link, the turn queue, transcripts, settings, and every IPC
  handler.
- `app/src/preload/`: two preload scripts exposing disjoint typed bridges,
  `window.sandiPet` (drag, click, display events) and `window.sandiChat`
  (everything else).
- `app/src/renderer/pet/`: no framework, one canvas and a reducer. Plays the
  spritesheet and turns pointer gestures into drag or open-chat intents.
- `app/src/renderer/chat/`: React 19 + Zustand. Transcript, composer, session
  drawer, pairing card, status bar.
- `app/src/shared/`: types and pure logic imported on both sides of the
  context bridge: the IPC contract, the animation manifest, the pet state
  machine, and the response buffer. No Node or Electron imports here.

The renderer tsconfig deliberately has no `@sandi-server` path mapping.
Importing server code into a renderer fails typecheck, which keeps Node code
out of the browser context by construction.

## Process architecture

Main owns all state; the renderers are pure UI over typed IPC.

- The pet window is exactly one sprite frame (192x208), transparent,
  chromeless, `screen-saver`-level always-on-top, not focusable, absent from
  the taskbar. Clicks pass through the sprite's transparent pixels: the
  renderer samples the current frame's alpha under the cursor and toggles
  `setIgnoreMouseEvents(flag, {forward: true})` on transitions.
- Dragging is manual. `-webkit-app-region: drag` on a transparent window trips
  long-standing DWM hit-test bugs on Windows, so the renderer only reports
  grip and release; main re-reads the true cursor from the `screen` module
  each tick and moves the window itself, which also sidesteps DPI coordinate
  mismatches. Every move (drag ticks and wander alike) goes through
  `moveWindow` in `main/pet-window.ts`, which reasserts the fixed frame size
  via `setBounds`. Plain `setPosition` on a fractional-DPI Windows display
  round-trips the bounds through physical pixels, and because it leaves the
  size untouched, that rounding compounds across a move loop and the sprite
  grows without bound.
- The chat window is a popover anchored next to the pet (pure
  `computeAnchoredPosition` with edge flipping). While open, the pet window's
  `onMove` hook fires on every reposition and calls `chat.follow`, which
  re-anchors (and re-flips sides near an edge) only when the popover is already
  visible, so it trails her as she is dragged. It is created hidden at startup
  and lives for the whole app life: closing hides it, and only the tray's Quit
  destroys it. There is deliberately no blur handler; it stays up when clicked
  away.
- The popover is movable and resizable, down to a minimum that keeps the
  composer usable. Moving uses a `-webkit-app-region` drag area on the header
  (safe here because the header sits on opaque pixels, unlike the pet).
  Resizing is manual: Windows drops `WS_THICKFRAME` from transparent windows,
  so there is no native resize frame, and the renderer's edge grips
  (`ResizeGrips.tsx`) report grip/tick/release while main applies bounds from
  the true cursor (pure `computeResizedBounds`), the same pattern as the pet
  drag. Both choices persist in settings: the size as-is, the position as an
  offset from the pet's top-left, so it reopens beside her wherever she has
  wandered and `follow` trails at the chosen offset instead of the default
  anchor. Restores clamp into the current work area (pure
  `computeOffsetPosition` and `clampSizeIntoWorkArea`) without rewriting the
  saved values, so a temporary small display does not erase the intent.
  Programmatic placements set a guard flag so only real gestures are recorded.
- The tray is the pet's only conventional chrome. Left click toggles her
  visibility; the context menu has open chat, wander, start-with-Windows, the
  link status line, the update section (packaged builds only: status line,
  manual check, and the automatic-update toggle), and Quit. The `Tray`
  instance stays in module scope because a garbage-collected wrapper silently
  drops the icon.
- Conversations are app-local. The server has no list or transcript endpoint
  (conversations are implicit and device-scoped), so main keeps one
  append-only JSONL per conversation plus an `index.json` for the sidebar,
  under the app's own data dir.
- The turn queue is client-side FIFO per conversation, mirroring the server's
  own ThreadQueue: one `sendTurn` POST in flight per conversation, extra
  submits render instantly as cancellable chips. Stop closes the in-flight
  socket, which aborts the pi child server-side.
- Streamed deltas arrive on the device link the app already holds. A shared
  response buffer dedupes and orders them per turn; the renderer renders the
  live text and main persists the reconciled final (the POST body stays
  authoritative).

### The pet's animation

The spritesheet is composed from per-animation source sheets in
`assets/pet-v2-src/` by `app/scripts/build-spritesheet.mjs` (run with
`npm run sprites -w app`), which chroma-keys, slices, and anchors each
animation into one row of `assets/sandi-spritesheet.webp`. The rows are a
fixed manifest (`shared/animation-manifest.ts`): idle, listening, thinking,
typing, and dragging as loops; celebrating, startled, casting, breathing, and
dozing as one-shots; one right-facing walk row that draws mirrored for
leftward strolls. Which row plays is a pure reducer in
`shared/pet-state-machine.ts`: main derives background changes and one-shots
from real turn and link events (listening on submit, typing while text
streams, thinking while she thinks, celebrating on success, startled on
error), the renderer feeds animation completion back in and dispatches drag
events from its own pointer gestures (she wiggles while held). Wander mode,
when enabled from the tray, occasionally strolls an idle pet horizontally
across her display's work area; main drives the walk
(`main/wander-scheduler.ts`) since main owns the window position, and any real
activity halts it within one tick.

### Attachments

The app uses one attachment mechanism in each direction (the server side is
documented in [`api-surface.md`](api-surface.md)):

- User to Sandi: staged images (picked, dropped, or pasted) upload to the
  server's content-addressed attachment store at submit time and the turn
  references their hashes, which puts them in the model's visual context.
  Non-image files are not uploaded because they already live on the machine
  where Sandi's hands-local tools run, so the message just lists their paths
  and she reads them herself.
- Sandi to user: her `attach_to_reply` tool relays hands-local paths through
  the device link as `response_attachment` events. The app collects them per
  turn, persists them in the transcript, renders images inline (through the
  `sandi-asset://` protocol, which serves any absolute local path; Sandi is
  unsandboxed by design), and offers save-as.

## Dev loop

```sh
npm install            # once, at the repo root
npm run dev:api        # terminal 1: a local server
npm run dev -w app     # terminal 2: the app with renderer HMR
```

`npm run dev -w app` builds the tray/window icons from `assets/sandi.png` on
the way in (`scripts/build-icons.mjs`). Point the app at the local server with
`SANDI_API_URL=http://127.0.0.1:<port>` in the environment; pairing from the
first-run card stores credentials in the same `desktop.json` the reference
CLI uses, so pairing once covers both.

`npm run check -w app` is the app's verification gate: typecheck (three
tsconfig projects), Biome lint and format, and the verify scripts for the pet
state machine, response buffer, window anchoring, transcript store, turn
queue, wander scheduler, and update state. All of them are pure logic run
with tsx; none need Electron. CI runs this as its own job with the Electron
binary download skipped.

## Packaging

```sh
npm run package -w app
```

electron-builder produces an NSIS installer and a portable exe under
`app/release/`, per `app/electron-builder.yml`. electron-vite bundles every
runtime dependency into `out/`, so the artifact ships no `node_modules`. The
mac and linux blocks in the config are stubs: nothing in the app is
Windows-only beyond the packaging targets, but only Windows is built and
smoke-tested today.

Known gap: the artifacts are unsigned, so SmartScreen warns on first run.

### Releases (CI)

Packaging runs in CI only on a version tag. Push a `vX.Y.Z` tag and the
`Package` workflow (`.github/workflows/package.yml`) builds both Windows
targets on a Windows runner and attaches the installers to that tag's GitHub
Release, along with the auto-update feed (`latest.yml` and the `.blockmap`
files) described below. The workflow stamps the tag's version into
`app/package.json` before building, so `app.getVersion()` (shown in the tray
menu) and the `${version}` in each artifact filename match the tag rather
than the committed `0.1.0`.

```sh
git tag v0.2.0
git push origin v0.2.0
```

The fast per-PR checks (`check-app`) skip the Electron binary and never run
electron-builder, so packaging-only breakage (a bad `electron-builder.yml`, a
missing icon, an asar path problem) surfaces at tag time, not on the PR. To
rehearse the pipeline without cutting a tag, run the workflow by hand via
`workflow_dispatch`, which packages at `app/package.json`'s own version and
uploads the artifacts to the run instead of a release.

### Auto-update

Existing installs pick up new releases on their own. The moving parts:

- The `publish` block in `app/electron-builder.yml` names this repo as the
  update source. At package time it makes electron-builder emit `latest.yml`
  (the feed: newest version, installer filename, hash) and a `.blockmap` per
  exe (for differential downloads), and embed the feed location into the
  installed app's resources (`app-update.yml`).
- The `Package` workflow uploads those files to the GitHub Release next to
  the installers. A release without `latest.yml` is invisible to existing
  installs, so the upload steps treat the feed files as required.
- `app/src/main/updater.ts` runs the client side, in three flavors. The
  installed (NSIS) app uses electron-updater: it checks shortly after launch
  and every few hours, downloads in the background, and stages the update to
  install on quit; the tray also offers "Restart to update". The portable exe
  cannot replace itself, so it only compares the latest release tag (GitHub's
  `releases/latest` API) against its own version and links to the download
  page. A dev run gets no updater at all.
- The phase transitions and tray copy are pure logic in
  `app/src/main/update-state.ts`, covered by `verify-update-state`. The tray's
  "Update automatically" checkbox (the `autoUpdate` setting, default on)
  gates the scheduled checks; a manual "Check for updates" always works.

The artifacts being unsigned does not block any of this: electron-updater
only enforces signature checks on Windows when the installed app itself is
signed.

## Manual smoke checklist

The verify scripts cover the pure logic; window behavior needs eyes on a real
desktop. After a change that touches windows, input, or packaging, check:

1. Launch: the pet appears at her saved spot (bottom-right on first run),
   transparent, above other windows, casting her greeting spell once. No
   taskbar entry.
2. Click-through: clicks on the transparent corners of her frame reach the
   desktop beneath; clicks on her body do not.
3. Drag: grabbing her body moves her smoothly and plays the picked-up wiggle
   until release; the position survives a relaunch; dragging near a screen
   edge does not strand her off-screen after a monitor change.
4. Tray: left click hides and shows her; Quit actually exits the process.
5. Pairing: with no `desktop.json`, the chat opens on the pairing card; a
   `/sandi auth` code pairs and the status bar flips to linked without a
   restart.
6. Chat loop: send a message, watch the reply stream, watch the pet listen,
   think with her orb, type the answer out, and celebrate on completion.
   Queue a second message while the first runs; its chip appears instantly
   and it sends after. Stop an in-flight turn mid-stream.
7. Attachments, outbound: attach a file via the picker, drop one from
   Explorer, and paste a screenshot; images upload and enter her visual
   context, plain files arrive as paths she reads locally.
8. Attachments, inbound: ask her to generate an image and attach it; it
   renders inline and save-as writes it where pointed.
9. Persistence: close the popover, reopen from the pet; the transcript is
   intact. Relaunch the app; sessions and transcripts are intact. Send a
   message and Quit from the tray right away, before it settles (the session
   index write is debounced); relaunch and confirm that session still sorts
   first with the right preview, not a stale one.
10. Chat geometry: drag the popover by its header and resize it from an edge;
    close and reopen it (pet click and tray both) and it comes back at the
    same size and the same position relative to the pet. Drag the pet and the
    popover trails at that offset. Relaunch the app; both survive. With the
    session drawer open, the drawer's own header buttons still click (they sit
    over the drag region).
11. Wander: enable it, leave her idle; she eventually strolls and any
    activity (a message, a drag, opening chat) stops her immediately.
12. Packaged build: the NSIS installer installs and launches; the portable
    exe runs from a bare folder; start-with-Windows takes effect on the
    packaged app.
13. Updates: on an installed build older than the latest release, the tray
    reaches "Restart to update to X" within a minute of launch and the
    restart lands on the new version; on the portable exe the same situation
    shows "Update X available" and opens the release page; an up-to-date
    install settles on "Sandi is up to date".
