# Desktop App Guidelines

This workspace member is Sandi's Electron desktop app: the sprite pet and its
popover chat. Read the repo root `AGENTS.md` first; everything there applies
here too. Architecture and the manual smoke checklist live in
`docs/developers/desktop-app.md`.

## Structure

- `src/main/`: Electron main process, the only code allowed to import server
  source (through the `@sandi-server` alias to `../src`). Composition root is
  `src/main/index.ts`.
- `src/preload/`: the two context-bridge scripts. Keep the pet and chat
  bridges disjoint.
- `src/renderer/pet/` and `src/renderer/chat/`: browser code only. The
  renderer tsconfig has no `@sandi-server` path on purpose; if an import of
  server code typechecks here, that is a bug in the config, not a green light.
- `src/shared/`: types and pure logic used on both sides of the bridge. No
  Node, Electron, or DOM imports.

## Commands

Run these from the repo root (or drop the `-w app` inside `app/`):

- `npm run dev -w app`: electron-vite dev loop with renderer HMR, against a
  server from `npm run dev:api`.
- `npm run check -w app`: the verification gate: typecheck, lint, format
  check, and the verify scripts. Keep it green; CI runs it as its own job.
- `npm run package -w app`: electron-builder Windows artifacts into
  `app/release/`.

## Conventions

- Style matches the root: Biome with the same rules (including the
  no-type-assertion plugin), 2-space indent, double quotes, kebab-case
  filenames. `app/biome.json` mirrors the root config; keep them aligned when
  the root changes.
- IPC is typed end to end. A new channel means: the type and channel name in
  `src/shared/ipc-contract.ts`, a zod schema in `src/main/ipc-schemas.ts`,
  validation in the main-side handler, and the preload exposure. Handlers
  must check `event.sender` against the owning window.
- Logic that can be pure should be pure and get a `verify-*.ts` script run by
  tsx without Electron (see the existing ones for the pattern). Window and
  input behavior that cannot be verified that way goes on the manual smoke
  checklist in the docs instead.
- New settings go through `src/main/settings-store.ts` (schema plus default),
  never ad hoc files. Credentials stay in the shared `desktop.json`; do not
  write app state there.
- Sandi is deliberately unsandboxed here (she is meant to have full control
  of the machine); do not add path allowlists or capability gates around her.
  Renderer `contextIsolation` stays on as ordinary hygiene for our own UI.
