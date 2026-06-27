# Repository Guidelines

## Project Structure & Module Organization

Sandi is a multi-surface AI bot written in TypeScript. The production entrypoint is the host (`src/host/index.ts`, run with `npm start`), which composes every configured surface (API/device, Discord, GitHub) into one process. Surface-specific entrypoints under `src/surfaces/<surface>/` (for example `src/surfaces/discord/index.ts`) still run a single surface standalone for development, and Discord command registration starts from `src/surfaces/discord/register-commands.ts`. Shared runtime behavior lives under `src/lib/`, including context compilation, memory and skill plumbing, conversations, provider integration, generic Pi extensions, runtime helpers, state stores, migrations, and turn queueing. Discord-only lifecycle, delivery helpers, events, reminders, commands, and Discord Pi extensions live under `src/surfaces/discord/`.

Configuration and policy starter text lives under `config/`. Runtime data,
memory, events, custom skills, generated helpers, and private overlays live under
`data/`; this is Sandi's normal self-extension surface. Avoid committing
generated private data unless intentionally updating checked-in builtin skills or
directory placeholders. Static images and sprites are in `assets/`. Project
notes are in `docs/`.

## Build, Test, and Development Commands

- `npm install`: install locked dependencies and configure the checked-in Git hooks through the `prepare` script.
- `npm run hooks:install`: reconfigure this checkout to use `.githooks/` if hooks are missing.
- `cp .env.example .env`: create local configuration, then fill Discord and Pi settings.
- `npm run dev` or `npm start`: run the composed host with `tsx src/host/index.ts`. Use `npm run dev:discord` (or `dev:api`, `dev:github`) to run a single surface standalone.
- `npm run commands:sync`: synchronize Discord application commands for the configured guild.
- `npm run typecheck` or `npm run build`: run TypeScript with `--noEmit`.
- `npm run lint`: run Biome lint checks.
- `npm run format`: apply Biome formatting for code and `oxfmt` for Markdown.
- `npm run check`: run the full verification gate: typecheck, lint, formatting, identity/memory, Pi account routing, event creator routing, token usage, migration, and surface-boundary checks.

## Coding Style & Naming Conventions

Use ES modules and TypeScript throughout `src/`. Biome enforces 2-space indentation, double quotes, semicolons, organized imports, `const`, no explicit `any`, no non-null assertions, and no type assertions through the configured plugin. Prefer small domain modules and descriptive kebab-case filenames such as `thread-queue.ts`.

Pi extension files are loaded directly by the Pi CLI, outside the app's `tsx` runtime and `tsconfig` path alias setup. Files under `src/lib/pi-extension/` and surface-specific Pi extension folders should use relative imports within the extension dependency graph, not the `@/*` alias, unless a direct `pi --extension` smoke test proves the loader can resolve the import.

## Testing Guidelines

There is no dedicated test suite checked in yet. Treat `npm run check` as the verification gate. When adding tests, use `*.test.ts`, place them near covered code or in a clear test directory, and add the runner command to `package.json`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Add Sandi reminder tools`. Capitalize the first word, keep the subject focused, and avoid bundling unrelated changes.

Pull requests should include a concise description, user-facing or operational impact, required config changes, and verification, especially `npm run check`. Include screenshots or Discord behavior notes when changing visible bot interactions or assets.

## Security & Configuration Tips

Do not commit `.env`, Discord tokens, Pi credentials, private memory, or generated conversation/session data. Update `.env.example` when adding configuration. Keep Pi extensions constrained to the tools Sandi needs, and validate paths or refs before touching file-backed state.
