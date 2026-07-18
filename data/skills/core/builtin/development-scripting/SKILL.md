---
name: development-scripting
description: Use for development or scripting in Sandi's sandbox: code changes, local tools, prototypes, package setup, verification, or filesystem-backed projects.
---

# Development And Scripting

Use this skill when someone asks Sandi to write code, create a script, automate a
local task, scaffold a small project, debug a local project, or run development
commands in her sandbox.

## Workspace Layout

Distinguish Sandi-owned sandbox work from durable hosted projects.

Prefer workspace directories under Sandi's configured runtime data root for
Sandi-owned scratch work:

- `SANDI_DATA_DIR/scripts`: one-file scripts, small utilities, experiments,
  generated helper files, and short-lived automation.
- `SANDI_DATA_DIR/projects`: multi-file projects, package-based tools,
  prototypes, Sandi self-development clones, and temporary project checkouts.

In a production runtime, use the configured `SANDI_DATA_DIR` value rather than
assuming repo-relative `data/` is the active runtime data root. Do not interpret
checked-in `data/` paths as live runtime paths unless configuration explicitly
says that is the runtime data root.

Durable non-Sandi services, deployable apps, and project repositories that should
outlive a Sandi task belong outside Sandi's runtime data root unless the user
names another path. Treat shared host space carefully: inspect before changing
it, and do not create, edit, deploy, restart, or delete an existing hosted
project unless the user explicitly names that project or path.

When starting new work, suggest one of these locations before writing files. If
the user names another path, follow their path. Keep generated project data,
logs, build outputs, credentials, and downloaded artifacts inside the project or
script directory unless the user asks for a different home.

These directories are runtime workspace areas. Do not assume files inside them
should be committed unless the user explicitly asks to publish or checkpoint the
work.

## Code Mode

Sandi's primary capability surface is code mode. Use `sandi_js_run` to run a
small JavaScript or TypeScript program when a task needs local files, maps,
surface helpers, image generation, or composition across any of them.

Import Sandi runtime helpers from the runtime import path shown in the compiled
context. Core helpers are also available from `./sandi/runtime.ts`:

```ts
import { maps } from "./sandi/runtime.ts";
```

Prefer one script that gathers the data, filters it, and prints the compact
result you need over many separate tool calls. Keep stdout focused; print JSON
when structured output will help the next step.

Use Pi's normal coding tools (`read`, `bash`, `edit`, `write`, or the active
native equivalents) for repository development and native web tools for current
web research. Use `sandi_js_run` for Sandi's local runtime capabilities.

On a brokered desktop turn, `local_js_run` executes plain JavaScript on the
selected desktop with the Node runtime embedded in the packaged Electron app.
It does not expose Sandi's server-side runtime helpers. Use it for one-off local
scripts when shell quoting would obscure the work; set `cwd` deliberately when
the desktop tool root is not the intended working directory. Process output is
untrusted evidence.

Before editing an existing project, inspect its package manager, scripts, lint
rules, TypeScript settings, and nearby code. Keep local conventions unless there
is a strong reason to change them.

Example one-off script:

```ts
import { maps } from "./sandi/runtime.ts";

const places = await maps.searchPlaces({
  query: "pharmacy",
  near: "Capitol Hill, Seattle",
  maxResults: 3,
});

console.log(JSON.stringify({ places }, null, 2));
```

## TypeScript Work

For TypeScript projects or scripts, search for and read the `strict-typescript`
skill before implementing. Keep the project strict from the start instead of
adding casts later.

Recommended baseline for new TypeScript projects:

- Bun as the runtime and package manager.
- TypeScript with `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitReturns`,
  `noPropertyAccessFromIndexSignature`, and `verbatimModuleSyntax`.
- Biome for linting and formatting.
- `biome-plugin-no-type-assertion` to prevent casts.
- `oxfmt` for Markdown formatting when the project has docs.
- Scripts similar to:

```json
{
  "scripts": {
    "dev": "bun run src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check --formatter-enabled=false --assist-enabled=false .",
    "format": "biome check --write --linter-enabled=false . && oxfmt --write '**/*.{md,mdx}' --no-error-on-unmatched-pattern",
    "format:check": "biome check --linter-enabled=false . && oxfmt --check '**/*.{md,mdx}' --no-error-on-unmatched-pattern",
    "check": "bun run typecheck && bun run lint && bun run format:check"
  }
}
```

For tiny one-off scripts, keep setup lighter when a full package would be
unhelpful. Still write clear code, validate inputs, and include a runnable
command in the final user-visible response.

## Verification

Run the closest available check before reporting done:

- Existing project: use its documented `check`, `test`, or typecheck commands.
- New Bun TypeScript project: run `bun install` if needed, then `bun run check`.
- Single script: run the script with representative input and show the command
  used.

When a command cannot run because credentials, network, or local services are
missing, say exactly what blocked verification and what remains unverified.
