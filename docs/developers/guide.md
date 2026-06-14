# Developer Guide

This guide collects setup, runtime, and contributor details for people working
on Sandi's source or operating a deployment. For partner-facing orientation,
start with the project [README](../../README.md).

## Project Shape

Sandi is a multi-surface AI bot written in TypeScript. The current production
surface is Discord, but the runtime is shaped so future surfaces can have their
own harnesses while sharing memory, skills, policies, identity context, provider
integration, and turn queueing.

The current shape is:

- Discord forum channel: one forum post is one Sandi conversation.
- Pi-backed provider turns, with optional strict account routing for mapped
  human identities.
- Sandi-owned Discord identity, participant tracking, compiled instructions,
  scoped memory, operational policies, Discord tools, scheduled events,
  interactive human reminders, and interactive todo lists.
- Shared runtime code under `src/lib/`.
- Discord-specific lifecycle, event intake, delivery, commands, and runtime
  helpers under `src/surfaces/discord/`.
- File-backed config and runtime state.

## Local Setup

Install dependencies:

```sh
npm install
```

`npm install` also configures the repository's Git hook path so the checked-in
pre-commit hook runs `npm run check` before local commits. If hooks are missing
in an existing checkout, run `npm run hooks:install` once.

Create `.env` from the example:

```sh
cp .env.example .env
```

Fill in:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `SANDI_FORUM_CHANNEL_ID`, or create a forum channel named by
  `SANDI_FORUM_CHANNEL_NAME`
- `SANDI_PI_COMMAND`, usually `pi`

Sync Sandi's Discord application commands for the configured guild:

```sh
npm run commands:sync
```

Start Sandi:

```sh
npm run dev
```

## Deployment

Use the dedicated deployment guides:

- [Docker deployment](docker.md): image build, GHCR publishing, persistent
  `/app/data`, and Pi authentication inside the container volume.
- [Manual deployment](manual-deployment.md): direct Linux/systemd deployment
  with separate app and runtime-data roots.

## Discord Runtime

Sandi has three persistent Discord conversation modes:

- Sandi forum posts: every non-bot message inside a Sandi forum thread becomes a
  persistent Pi turn for that forum conversation. The first response to a
  message replies to the triggering message.
- Standing channel rooms: mentioning Sandi in a supported text channel creates
  or resumes a persistent room conversation for that channel. The first response
  to a mention replies to the triggering message.
- Existing Sandi-managed channel threads: any Discord thread with a stored
  Sandi-managed thread conversation manifest continues to receive non-bot
  replies as persistent Pi turns without requiring a mention. There is no
  user-facing thread creation command, and mentioned channel messages containing
  "thread" are handled as ordinary standing-channel conversation instead of
  auto-branching.

When available, Discord message and scheduled-event metadata includes the active
channel topic and thread parent-channel topic so Sandi can see room norms or
standing context without needing a separate history lookup. Thread message
metadata also includes a small best-effort digest of recent messages since
Sandi's last visible reply.

Sandi listens for human reactions on her own messages and carries a small digest
of those reactions into the next non-event turn in that conversation. Reactions
are treated as sideband context, not as standalone prompts that trigger agent
turns.

Forum threads, Sandi-managed channel threads, and standing channel rooms use
persistent Pi sessions. One-off mention handling remains as a fallback for
Discord contexts that are not persistent conversation channels.

The wrapper posts Pi's final stdout back to Discord as Sandi's ordinary reply
when the turn has not already used an explicit Discord send helper/tool.
Successful Discord send helpers mark the turn as having a Discord side effect,
so the wrapper suppresses the automatic final-text post and avoids duplicate
messages.

## Pi CLI

Sandi shells out to the local `pi` command and assumes each configured Pi account
directory is already authenticated. Sandi does not handle OpenAI passwords,
OAuth browser flows, or API keys directly.

The default command shape is:

```sh
printf '%s' '<message>' | pi --print \
  --extension ./src/lib/pi-extension/js-run-tool.ts \
  --extension ./src/lib/pi-extension/memory-tools.ts \
  --extension ./src/lib/pi-extension/skill-tools.ts \
  --extension ./src/lib/pi-extension/policy-tools.ts \
  --extension ./src/lib/pi-extension/imagegen-tools.ts \
  --extension ./src/lib/pi-extension/stop-sentinel.ts \
  --extension ./src/lib/pi-extension/token-usage-recorder.ts \
  --session <conversation-session-file> \
  --system-prompt <short-notice> \
  --append-system-prompt <compiled-context-payload-file>
```

Startup runs the same Pi setup preflight as `npm run setup:pi` before Discord
connects. The preflight expects Pi `0.77.0`, writes Sandi-owned
`pi-codex-conversion.json` into the default Pi agent dir and every configured
account agent dir, installs packages from `config/pi-packages.json`, removes
blocked packages, and verifies the configured provider/model can be listed
offline.

The checked-in conversion config enables native OpenAI Responses compaction,
native converted file-edit tool calls, and native web search through the Codex
conversion extension. Codex Conversion's `imagegen` tool is disabled so Sandi's
richer `image_generate` extension remains the image-generation path.

Main turns intentionally leave Pi extension discovery and builtin tools enabled
so installed conversion tools can load; read-only nested search sessions still
disable discovery and builtin tools explicitly.

### Pi Defaults

- `SANDI_DATA_DIR=./data`
- `SANDI_CONFIG_DIR=./config`
- `SANDI_PI_COMMAND=pi`
- `SANDI_PI_PACKAGE_MANIFEST=./config/pi-packages.json`
- `SANDI_PI_AGENT_DIR` optionally overrides the default Pi agent dir used for
  setup.
- `SANDI_PI_PACKAGE_DIR` optionally overrides the Pi package install dir used
  for setup.
- `SANDI_PI_SESSION_DIR=./data/pi-sessions`
- Pi account routing is loaded by convention from
  `./data/config/pi-accounts.json`, falling back to `./config/pi-accounts.json`.
  The public repo ships only `config/pi-accounts.example.json`, so account
  routing is disabled until a private live config exists.
- `SANDI_PI_JS_EXTENSION=./src/lib/pi-extension/js-run-tool.ts`
- `SANDI_PI_MEMORY_EXTENSION=./src/lib/pi-extension/memory-tools.ts`
- `SANDI_PI_SKILL_EXTENSION=./src/lib/pi-extension/skill-tools.ts`
- `SANDI_PI_POLICY_EXTENSION=./src/lib/pi-extension/policy-tools.ts`
- `SANDI_PI_IMAGEGEN_EXTENSION=./src/lib/pi-extension/imagegen-tools.ts`
- `SANDI_PI_STOP_EXTENSION=./src/lib/pi-extension/stop-sentinel.ts`
- `SANDI_PI_MEMORY_SEARCH_EXTENSION=./src/lib/pi-extension/memory-search-read-tools.ts`
- `SANDI_PI_MEMORY_SEARCH_THINKING=medium`
- `SANDI_PI_MEMORY_SEARCH_TIMEOUT_MS=120000`
- `SANDI_PI_SKILL_SEARCH_EXTENSION=./src/lib/pi-extension/skill-search-read-tools.ts`
- `SANDI_PI_SKILL_SEARCH_THINKING=medium`
- `SANDI_PI_SKILL_SEARCH_TIMEOUT_MS=120000`
- `SANDI_PI_EXTENSIONS` optionally overrides the default main-turn extension
  list with a comma-separated list.
- `SANDI_GOOGLE_MAPS_API_KEY` or `GOOGLE_MAPS_API_KEY` configures Google Maps
  Places tools.
- `SANDI_PI_TIMEOUT_MS=3600000`
- `SANDI_PI_MODEL=gpt-5.5` maps to `--model gpt-5.5`
- `SANDI_PI_PROVIDER=openai-codex` maps to `--provider openai-codex`
- `SANDI_PI_THINKING=high` maps to `--thinking high`
- Policies are loaded by convention from `./data/config/policies`, followed by
  `./config/policies`.
- `SANDI_EVENTS_ROOT=./data/events`
- `SANDI_SKILLS_ROOT=./data/skills`
- `SANDI_GENERATED_IMAGES_ROOT=./data/generated-images`
- `SANDI_SURFACE_ATTACHMENTS_ROOT=./data/surface-attachments` optionally allows
  core image generation to read uploaded-image references made available by the
  current surface. The Discord surface sets this for Discord turns and defaults
  the underlying storage to `./data/discord-attachments`.
- `SANDI_ENVIRONMENT_HINT` optionally adds a non-secret deployment note to
  Sandi's runtime context.

The checked-in environment example uses `SANDI_PI_PROVIDER=openai-codex` and
`SANDI_PI_MODEL=gpt-5.5` for the ChatGPT/Codex-authenticated Pi route. Adjust
those values if your local Pi installation exposes a different provider or model
name.

### Account Routing

`data/config/pi-accounts.json` routes Discord turns by mapped human identity
when present. Sandi does not borrow another human's ChatGPT/Codex subscription
when a mapped account is missing `auth.json`, reaches quota, or hits a rate
limit. Those failures are surfaced to Discord so the account owner can log in,
wait for reset, add credits, or change their own plan.

Human turns without a mapped identity fail closed. Scheduled Sandi events must
store the mapped Discord identity that created them, and event-triggered model
turns run under that creator's ChatGPT/Codex account while appending to the
shared conversation session.

The Pi transcript remains one shared session file per Discord conversation, so
multiple people can participate in and append to the same Sandi session. Account
routing is still evaluated independently on every model turn from the mapped
human identity.

Example account directories are:

- Primary human: `${HOME}/.pi/agent`
- Secondary human: `${SANDI_DATA_DIR}/pi-accounts/secondary`

To enable a secondary account on a runtime host, authenticate Pi once with
`PI_CODING_AGENT_DIR` pointing at that account directory:

```sh
mkdir -p ./data/pi-accounts/secondary
PI_CODING_AGENT_DIR=./data/pi-accounts/secondary pi
```

Then run `/login` in Pi and select the ChatGPT/Codex subscription provider.

Provider logs include an audit record for each Pi model turn:
`provider account route selected`, followed by either
`provider account route completed` or `provider account route failed`. These
records include `audit: "per-human-chatgpt-account-routing"`,
`routingIdentityId`, `piAccountId`, `conversationId`, `sessionMode`, provider,
and model settings. They intentionally do not log prompts, tokens, refresh
tokens, or Pi account directory paths.

The model-visible turn metadata also includes account-routing provenance:
`account_routing_policy`, `account_routing_source`,
`account_routing_discord_user_id`, and `account_routing_identity_id`.

## Runtime Tools

For concrete local composition, Sandi composes code mode through
`sandi_js_run`: a small TypeScript/JavaScript program that imports helpers from
the runtime import path owned by the current surface. Discord turns use the stable
`./sandi/runtime.ts` import, which is generated per run and re-exports the
active Discord runtime helpers plus shared maps helpers.

Memory, skills, policies, and image generation remain direct Pi tools:

- Memory: `memory_list`, `memory_read`, `memory_search`, `memory_write`,
  `memory_forget`
- Skills: `skill_list`, `skill_read`, `skill_search`, `skill_write`,
  `skill_delete`
- Policies: `policy_list`, `policy_read`
- Images: `image_generate`

Memory tool refs are logical refs such as `system/MEMORY.md`,
`household/MEMORY.md`, `discord/<discord-user-id>/preferences.md`,
`topics/meal-planning/preferences.md`,
`surfaces/discord/threads/<thread-id>/2026-05-04/recap.md`, and
`surfaces/discord/channels/<channel-id>/MEMORY.md`. The extension validates
every ref against the allowed memory scopes before reading, writing, or deleting
anything.

`memory_search` and `skill_search` delegate to separate ephemeral Pi search
sessions using read-only search extensions. The search subagents can list, grep,
and read allowed memory refs or effective skills, but cannot write memory, edit
skills, or use Discord helpers.

Skills live under `data/skills/core/{builtin,custom}/<skill-name>/SKILL.md` and
`data/skills/surfaces/<surface>/{builtin,custom}/<skill-name>/SKILL.md`. Reads
and searches use the effective skill set for the current surface. For Discord,
precedence is Discord custom, Discord builtin, core custom, core builtin.
`skill_write` defaults to the current surface when a surface context is present;
pass `scope: "core"` only for truly global instructions.

The Discord entrypoint passes `SANDI_SKILLS_SURFACE=discord`,
`SANDI_RUNTIME_IMPORT=./sandi/runtime.ts`, and
`SANDI_RUNTIME_ENTRY=./src/surfaces/discord/runtime/index.ts` to Pi child
processes. These are runtime context values, not user configuration choices.

Core builtin workflow skills include:

- `development-scripting`
- `google-maps`
- `image-generation`
- `pull-request`
- `self-development`
- `skill-creator`
- `strict-typescript`
- `web-research`

Discord surface builtin workflow skills include:

- `discord-participation`
- `image-generation`
- `reminders`
- `temporal-continuity`

Operational policies live under `data/config/policies/` and `config/policies/`.
The compiled prompt includes a merged policy index; Sandi can read full policy
text through `policy_read` without needing arbitrary filesystem access.

Scheduled events live under `data/events/`. Sandi can create immediate,
one-shot, or periodic scheduled turns for Discord forum threads or standing
channel rooms through the code-mode `events` helper, and the bot process watches
the event directory so due events re-enter the normal queued conversation path.

## Config And Data

Root behavior lives in `data/config/soul.md` for private deployments, falling
back to the public default in [config/soul.md](../../config/soul.md).

Operational policies live under `data/config/policies/` and `config/policies/`.
Private policies shadow public policies with the same ref. These are runtime
instructions for recurring situations, such as memory handling, that should be
available to Sandi without bloating the soul file.

Per-user config lives under
`data/config/users/<platform>/<platform-user-id>/`, falling back to
`config/users/<platform>/<platform-user-id>/`:

```text
config/users/discord/1234567890/
  profile.md
  instructions.md

config/users/github/22222222/
  profile.md
  instructions.md
```

The context compiler reads `profile.md` and `instructions.md`. Private
cross-platform human mappings live in `data/config/identities/humans.json`. The
public repo includes `config/identities/humans.example.json` for schema-shaped
examples.

Every conversation manifest is stored under
`data/conversations/<target-id>/manifest.json`, where the target is either a
forum thread id or a standing channel id. Forum thread conversations use
canonical ids shaped like
`discord:<guild-id>:<parent-channel-id>:<thread-id>`; standing channel rooms use
`discord:<guild-id>:<channel-id>:room`.

Runtime memory lives under `data/memory/`:

```text
data/memory/
  system/
  self/
  household/
  discord/<discord-user-id>/
  github/<github-user-id>/
  topics/<topic-id>/
  surfaces/discord/threads/<discord-thread-id>/
  surfaces/discord/channels/<discord-channel-id>/
```

Each scope may have a short `MEMORY.md` scratchpad. The compiled context
includes the system, self, and household scratchpads, the current thread or
channel-room scratchpad when there is one, and active participant scratchpads.
Other Markdown memory files are reached through the memory tools.

Data directories are versioned with `data/.version`. Startup migrations back up
affected `data/memory/`, `data/skills/`, and `data/conversations/` roots to a
sibling `data.backups/` folder before mutating them.

Sandi-owned runtime state files that may carry household context or credentials
are written owner-only (`0600`) when Sandi updates them, including memory,
custom skills, conversation manifests, scheduled events, reminders, and
refreshed Pi/OpenAI auth files.

Runtime skills live under `data/skills/`:

```text
data/skills/
  core/
    builtin/<skill-name>/SKILL.md
    custom/<skill-name>/SKILL.md
  surfaces/
    discord/
      builtin/<skill-name>/SKILL.md
      custom/<skill-name>/SKILL.md
```

Sandi-authored development work should live under:

```text
data/scripts/
data/projects/
```

Use `data/scripts/` for one-off scripts and small utilities. Use
`data/projects/` for multi-file or package-based projects. These areas are
runtime workspace directories and are ignored by git except for placeholders.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm run check
```

The TypeScript/Biome rules enforce strict TypeScript, no explicit `any`, no
non-null assertions, double quotes, semicolons, and organized imports.
