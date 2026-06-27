# Surface Contract

Sandi can appear through more than one interaction surface. A surface is a
platform-specific harness and delivery loop, such as Discord or GitHub. Surfaces
should be distinct harnesses that share Sandi's core runtime
instead of adapting one surface's harness to impersonate another.

Surfaces are distinct harnesses, but they are not isolated processes. The host
(`src/host/index.ts`) composes every configured surface into one process so they
share a single conversation store, provider, and device registry. Because
surfaces share one process, a desktop turn can post to Discord and a Discord turn
can run shell commands on a linked desktop. See [Process Topology](#process-topology) and
[Tool Reach Across Surfaces](#tool-reach-across-surfaces).

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

## Process Topology

The host composition root (`src/host/index.ts`) is the production entrypoint
(`npm start`). It loads one configuration, builds the shared singletons once, and
starts every surface that is configured:

- a single `ConversationStore`, `PiCliClient`, and embedding-index maintainer, so
  a human's conversations and account routing stay unified across surfaces;
- a single `DeviceRegistry` and `ToolBroker`, so a desktop holds one link and a
  turn from any surface can reach it;
- one `BrokerDesktopHands` (the shared desktop-hands capability) injected into the
  Discord and GitHub bots.

Each surface is enabled independently: the API/device surface is on by default
(set `SANDI_API_ENABLED=false` to disable it), Discord starts when a bot token is
present, and GitHub starts when `SANDI_GITHUB_ENABLED=true`. A surface still has
its own standalone entrypoint (`npm run dev:discord`, `dev:api`, `dev:github`)
for isolated development, where no other surface and no shared device links
exist.

A surface exposes a uniform `start()`/`stop()` lifecycle. The host owns process
startup and shutdown. It starts the shared broker before any surface, starts each
surface in sequence, and on shutdown stops every surface before closing the shared
registry and broker once.

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

- a `start()`/`stop()` lifecycle the host drives, plus a standalone entrypoint
  for isolated development;
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

## Tool Reach Across Surfaces

Which tools a turn can use is decided per turn by what is reachable in that
moment, not by which surface the turn came in on. A turn gets the union of two
kinds of hands, and the platform context tells Sandi where she is and what is
connected so she can pick the right one.

- **Server hands.** Every surface points its `sandi_js_run` runtime entry at the
  unified runtime (`src/host/runtime/index.ts`), which re-exports every surface's
  server-side helpers: Discord, GitHub, events, reminders, todo, and maps. A turn
  from any surface can therefore compose any of them, for example a desktop turn
  posting a Discord message or commenting on a GitHub pull request. The helpers
  reach their services with credentials from the environment (the Discord bot
  token, the `gh` CLI) and read the current platform target from
  `SANDI_PLATFORM_CONTEXT` when one is set. Used outside their native surface they
  require an explicit target (a channel id, or an owner/repo/number) because there
  is no "current" channel or thread.
- **Desktop hands.** When the human behind a turn has a desktop holding a device
  link, the turn leases a per-turn broker ticket for that desktop (resolved by
  identity, never another human's machine) and the hands-local `local_*` proxy
  tools run file and shell work on that desktop. This works from Discord and
  GitHub turns, not only desktop turns.

`sandi_js_run` (server-side code execution) is enabled on every surface, matching
Discord turns in the same deployment. The desktop surface keeps pi's built-in file
and shell tools off so file and shell work flows to the desktop through `local_*`
rather than the server, leaving a single filesystem for those operations.

The bots depend on the core `DesktopHands` interface
(`src/lib/provider/desktop-hands.ts`), and the API surface provides the
`BrokerDesktopHands` implementation over the shared registry and broker.

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

1. Create `src/surfaces/<surface>/` with a `start()`/`stop()` bot and a
   standalone entrypoint for isolated development, then register the surface in
   the host (`src/host/index.ts` and `src/host/config.ts`) so it runs in the
   merged process and is gated by its own enable signal.
2. Reuse `src/lib` for context, memory, skills, policies, identity, provider
   calls, and generic state primitives.
3. Add surface-specific runtime helpers and Pi extensions under that surface.
4. Re-export the surface's runtime helpers from the unified runtime barrel
   (`src/host/runtime/index.ts`) so every surface can compose them, and set the
   surface context to the shared `UNIFIED_RUNTIME_ENTRY` and the stable code-mode
   import path (`./sandi/runtime.ts`), along with the skills surface name. Make
   helpers usable cross-surface by accepting an explicit target rather than
   requiring the current platform context.
5. Define canonical conversation IDs and queue keys for the surface before
   storing manifests.
6. Pass platform participants with durable platform user IDs.
7. Record delivery side effects when a helper visibly posts through the surface.
8. To let the surface reach a human's desktop, resolve the actor's identity and
   lease through the injected `DesktopHands` capability, adding `localToolBroker`
   to the provider request.
9. Document required configuration and verification steps in the PR.

Do not make the Discord harness responsible for another platform's event loop or
API behavior. Shared Sandi, separate masks.
