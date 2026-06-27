# Developer Guide

This guide collects setup, runtime, and contributor details for people working
on Sandi's source or operating a deployment. For partner-facing orientation,
start with the project [README](../../README.md).

## Project Shape

Sandi is a multi-surface AI bot written in TypeScript. The current production
chat surface is Discord, and the GitHub surface polls notifications through an
already-authenticated `gh` CLI user. Surfaces share memory, skills, policies,
identity context, provider integration, runtime shims, and turn queueing.

The current shape is:

- Discord forum channel: one forum post is one Sandi conversation.
- Pi-backed provider turns, with optional strict account routing for mapped
  human identities.
- Sandi-owned Discord identity, participant tracking, compiled instructions,
  scoped memory, operational policies, Discord tools, scheduled events,
  interactive human reminders, and interactive todo lists.
- Sandi-owned GitHub identity, notification routing for direct mentions and PR
  review requests, GitHub runtime helpers, and PR/issue delivery.
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

Start the GitHub surface:

```sh
gh auth status
npm run dev:github
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
- Sandi message threads: mentioning Sandi in a top-level text channel that is
  not an automatic Sandi-handled channel creates a Discord thread from that user
  message. The thread starts as `new thread`, then Sandi runs a short no-session
  Pi title turn with the normal configured model and low thinking to rename it
  from the starter message. The origin message is the first user prompt for a new
  persistent Pi session scoped to that thread. Later non-bot replies inside the
  thread trigger Sandi without requiring a mention. Other top-level
  parent-channel messages get their own Sandi thread sessions.
- Automatic channel rooms: channels with dedicated automatic handling, such as
  `todo-` and `tasks-` channels, continue to use persistent channel
  conversations instead of creating per-message threads.

When available, Discord message and scheduled-event metadata includes the active
channel topic and thread parent-channel topic so Sandi can see room norms or
standing context without needing a separate history lookup. Thread message
metadata also includes a small best-effort digest of recent messages since
Sandi's last visible reply.

Sandi listens for human reactions on her own messages and carries a small digest
of those reactions into the next non-event turn in that conversation. Reactions
are treated as sideband context, not as standalone prompts that trigger agent
turns.

Forum threads, Sandi message threads, and automatic channel rooms use persistent
Pi sessions. One-off mention handling remains as a fallback for Discord contexts
that are not persistent conversation channels.

The wrapper posts Pi's final stdout back to Discord as Sandi's ordinary reply
when the turn has not already used an explicit Discord send helper/tool.
Successful Discord send helpers mark the turn as having a Discord side effect,
so the wrapper suppresses the automatic final-text post and avoids duplicate
messages.

## GitHub Runtime

The GitHub surface starts with `npm run dev:github` and uses `gh api` for all
GitHub auth and API calls. It does not require Sandi to be a GitHub App or to
own webhook settings.

The poller watches participating notifications for direct mentions and review
requests. Mention notifications are verified against the latest comment body
before Sandi runs, because GitHub notification reasons can remain stale after
later activity. Review requests are routed when the PR issue events show Sandi's
GitHub user as the requested reviewer. A fresh state file ignores notifications
updated at or before startup unless
`SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS=true` is configured.

Each issue or pull request is one persistent conversation. GitHub turns use the
same `./sandi/runtime.ts` code-mode import, re-exporting `github` helpers for PR
metadata, changed files, diffs, issue comments, review comments, issue/PR
comments, review-comment replies, and pull request reviews.

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
- `SANDI_PI_FEEDBACK_EXTENSION=./src/lib/pi-extension/feedback-tools.ts`
- `SANDI_PI_POLICY_EXTENSION=./src/lib/pi-extension/policy-tools.ts`
- `SANDI_PI_IMAGEGEN_EXTENSION=./src/lib/pi-extension/imagegen-tools.ts`
- `SANDI_PI_STOP_EXTENSION=./src/lib/pi-extension/stop-sentinel.ts`
- `SANDI_PI_EXTENSIONS` optionally overrides the default main-turn extension
  list with a comma-separated list.
- `SANDI_GOOGLE_MAPS_API_KEY` or `GOOGLE_MAPS_API_KEY` configures Google Maps
  Places tools.
- `SANDI_PI_TIMEOUT_MS=3600000`
- `SANDI_PI_MODEL=gpt-5.5` maps to `--model gpt-5.5`
- `SANDI_PI_PROVIDER=openai-codex` maps to `--provider openai-codex`
- `SANDI_PI_THINKING=high` maps to `--thinking high`
- `SANDI_GH_COMMAND=gh` selects the GitHub CLI used by the GitHub surface.
- `SANDI_GH_TIMEOUT_MS=120000` bounds individual GitHub CLI API calls.
- `SANDI_GITHUB_LOGIN` optionally overrides the GitHub login Sandi should treat
  as herself; otherwise `gh api /user` is used.
- `SANDI_GITHUB_POLL_INTERVAL_MS=60000` controls GitHub notification polling.
- `SANDI_GITHUB_MAX_NOTIFICATIONS=50` controls notifications read per poll.
- `SANDI_GITHUB_NOTIFICATION_REASONS=mention,review_requested` controls the
  notification reasons the GitHub surface will route.
- `SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS=false` keeps first startup from
  acting on already-unread eligible notifications unless you opt in.
- Policies are loaded by convention from `./data/config/policies`, followed by
  `./config/policies`.
- `SANDI_EVENTS_ROOT=./data/events`
- `SANDI_FEEDBACK_ROOT=./data/feedback`
- `SANDI_SKILLS_ROOT=./data/skills`
- `SANDI_EMBEDDING_PROVIDER=local`
- `SANDI_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2`
- `SANDI_EMBEDDING_DTYPE=q8`
- `SANDI_EMBEDDING_CACHE_DIR=./data/embedding-models`
- `SANDI_EMBEDDING_BATCH_SIZE=24`
- `SANDI_EMBEDDING_LOCAL_FILES_ONLY=false` optionally prevents model downloads
  after the local embedding model is cached.
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
the runtime import path owned by the current surface. Surface turns use the
stable `./sandi/runtime.ts` import, which is generated per run and re-exports
the active surface runtime helpers plus shared maps helpers.

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

`memory_search` and `skill_search` run direct hybrid retrieval inside the main Pi
turn. They combine lexical BM25 with local CPU embeddings from
`SANDI_EMBEDDING_MODEL`, index metadata plus Markdown passages, aggregate
passage matches back to logical refs or skill names, and leave full content
loading to `memory_read` or `skill_read`. Prompt-time hints use the same
retrieval path and include descriptions or summaries plus compact match evidence
so the model can decide whether to read more.

Persistent passage embeddings live under `data/cache/embeddings/skills` and
`data/cache/embeddings/memory`. Each promoted generation has a `manifest.json`
with the index version and source content hash plus an `index.json` of embedded
passages; `current.json` points at the active generation. Startup validation and
file watchers rebuild stale indexes in the background and keep using the
previous generation until the new one is promoted.

Skills live under `data/skills/core/{builtin,custom}/<skill-name>/SKILL.md` and
`data/skills/surfaces/<surface>/{builtin,custom}/<skill-name>/SKILL.md`. Reads
and searches use the effective skill set for the current surface. For Discord,
precedence is Discord custom, Discord builtin, core custom, core builtin.
`skill_write` defaults to the current surface when a surface context is present;
pass `scope: "core"` only for truly global instructions.

Each surface sets its own `SANDI_SKILLS_SURFACE` (for example `discord` or
`github`) and `SANDI_RUNTIME_IMPORT=./sandi/runtime.ts` for Pi child processes.
Every surface points `SANDI_RUNTIME_ENTRY` at the one unified runtime,
`./src/host/runtime/index.ts`, so a turn on any surface can reach the Discord,
GitHub, and other server-side helpers. These are runtime context values, not
user configuration choices.

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
one-shot, or periodic scheduled turns for Discord threads or standing channel
rooms through the code-mode `events` helper, and the bot process watches the
event directory so due events re-enter the normal queued conversation path.

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
`data/conversations/<target-id>/manifest.json`, where the target is usually a
Discord thread id and can also be an automatic channel id. Thread conversations
use canonical ids shaped like
`discord:<guild-id>:<parent-channel-id>:<thread-id>`; channel rooms use
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
