# Surface Contract

Sandi can appear through more than one interaction surface. A surface is a
platform-specific harness and delivery loop, such as Discord or GitHub. Surfaces
should be distinct harnesses that share Sandi's core runtime
instead of adapting one surface's harness to impersonate another.

## Terminology

- **Surface**: a user-facing integration and runtime harness. A surface owns how
  external events become Sandi turns and how Sandi-visible output is delivered
  back to that integration. Examples: Discord surface, GitHub surface.
- **Platform**: a durable account namespace used for participants, identity
  mapping, and memory refs. Examples: `discord`, `github`.
- **Shared core**: surface-agnostic Sandi runtime under `src/lib/`. This is the
  reusable layer that carries Sandi's continuity and turn conventions across
  surfaces.

A surface and a platform often have the same name, but they are not the same
concept. `src/surfaces/github/...` is the GitHub surface; `github/<user-id>` is a
platform memory namespace.

## Shared Core Owns

Shared core code belongs in `src/lib/...` when it is useful across surfaces or
when it represents Sandi's continuity rather than one platform's delivery shape.

The shared core owns:

- context compilation and prompt sections;
- memory scope construction and memory tool validation;
- skill and policy loading;
- cross-platform human identity resolution;
- conversation manifest types and file-backed stores when their model is shared;
- provider client behavior and generic turn-side-effect markers;
- generic Pi extensions and code-mode helpers;
- state-store primitives, migrations, logging, and turn queueing utilities.

Shared core code should not import a surface module unless it is an explicit
compatibility bridge. Prefer dependency injection or a small shared interface when
core behavior needs a surface-provided value.

## A Surface Owns

Surface code belongs in `src/surfaces/<surface>/...` when it depends on a
specific integration's APIs, credentials, event model, delivery rules, or user
experience.

A surface owns:

- its process entrypoint and startup lifecycle;
- external event intake and normalization into Sandi turns;
- platform-specific conversation key decisions;
- platform-specific participant extraction;
- auth, API clients, and webhook or polling behavior;
- delivery behavior and duplicate-send suppression for that surface;
- surface-specific runtime helpers and Pi extensions;
- surface-owned runtime barrels, stable code-mode import shims, and skill
  surface context passed to provider turns;
- commands, reminders, reactions, issue comments, review comments, or other
  integration-native interactions.

Discord-specific behavior should stay under `src/surfaces/discord/...`.
GitHub-specific behavior should stay under `src/surfaces/github/...` with its
own entrypoint and delivery loop, while reusing `src/lib/...` for Sandi
continuity.

## Identity And Memory Boundaries

Conversation participants should keep their platform account identity:

```text
discord:<discord-user-id>
github:<github-user-id>
```

Known humans can be mapped across platforms through
`data/config/identities/humans.json`, falling back to
`config/identities/humans.json` when present, but platform memory arenas remain
distinct by default:

```text
data/memory/discord/<discord-user-id>/
data/memory/github/<github-user-id>/
data/memory/surfaces/discord/threads/<thread-id>/
data/memory/surfaces/discord/channels/<channel-id>/
data/memory/surfaces/github/repos/<owner>/<repo>/
```

This lets Sandi recognize that the same human can appear through Discord and
GitHub while still preserving where a fact was learned and which surface exposed
it. Surface conversation memory lives under `surfaces/<surface>/...` so thread
and channel archives are not accidentally shared across future surfaces.
Cross-platform memory bridging should be explicit, not an accidental effect of
sharing a display name or login.

## Adding A New Surface

When adding a new surface:

1. Create `src/surfaces/<surface>/` with its own entrypoint and platform event
   loop.
2. Reuse `src/lib` for context, memory, skills, policies, identity, provider
   calls, and generic state primitives.
3. Add surface-specific runtime helpers and Pi extensions under that surface.
4. Add a runtime barrel such as `src/surfaces/<surface>/runtime/index.ts`, then
   have the surface entrypoint pass both the stable code-mode import path
   (`./sandi/runtime.ts`) and the real runtime entry path to context compilation
   and provider requests, along with the skills surface name.
5. Define canonical conversation IDs and queue keys for the surface before
   storing manifests.
6. Pass platform participants with durable platform user IDs.
7. Record delivery side effects when a helper visibly posts through the surface.
8. Document required configuration and verification steps in the PR.

Do not make the Discord harness responsible for another platform's event loop or
API behavior. Shared Sandi, separate masks.
