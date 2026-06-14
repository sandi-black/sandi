# Sandi Current State

This document describes the repo as it works now. Runtime behavior is defined by
the code under `src/`, the config under `config/`, and file-backed state under
`data/`.

## Runtime

Sandi is a TypeScript multi-surface household agent with file-backed state and
the local `pi` command. The runtime is intentionally self-extending: a deployment
can replace the soul, policies, user config, memory, custom skills, runtime
helpers, and local state through the data directory while keeping the shared
source harness stable. The current production surface is Discord, implemented
with `discord.js`. The surface/core boundary is documented in
[`surfaces.md`](surfaces.md): surfaces own platform-specific event intake
and delivery, while `src/lib/...` owns shared Sandi continuity such as memory,
skills, policies, identity context, provider behavior, and reusable runtime
helpers.

`src/surfaces/discord/index.ts` wires together:

- `SandiBot`
- `ConversationStore`
- `ContextCompiler`
- `PiCliClient`

The bot listens with the Discord `Guilds`, `GuildMessages`, and privileged
`MessageContent` intents. It finds the configured Sandi forum channel by
`SANDI_FORUM_CHANNEL_ID`, or by `SANDI_FORUM_CHANNEL_NAME` when no ID is set.

## Discord Behavior

Sandi has three persistent Discord conversation modes:

- Sandi forum posts: every non-bot message inside a Sandi forum thread becomes a
  persistent Pi turn for that forum conversation. The first response to a message
  replies to the triggering message.
- Standing channel rooms: mentioning Sandi in a supported text channel creates or
  resumes a persistent room conversation for that channel. The first response to
  a mention replies to the triggering message.
- Existing Sandi-managed channel threads: any Discord thread with a stored
  Sandi-managed thread conversation manifest continues to receive non-bot
  replies as persistent Pi turns without requiring a mention. There is no
  user-facing thread creation command, and mentioned channel messages containing
  "thread" are handled as ordinary standing-channel conversation instead of
  auto-branching.

When available, Discord message and scheduled-event metadata includes the active
channel topic and thread parent-channel topic so Sandi can see room norms or
standing context without needing a separate history lookup. For thread message
turns, metadata also includes a small best-effort digest of recent thread
messages since Sandi's last visible reply, helping recover context from queued
human chatter or downtime without copying parent-channel transcripts.

When a new Discord user speaks in a persistent conversation, Sandi adds that user
to the conversation manifest. One-off mention handling remains as a fallback for
Discord contexts that are not persistent conversation channels. Sandi sends typing
indicators while Pi is running.

Sandi has Discord application commands registered by `npm run commands:sync`:

- `/sandi help`: shows the available Sandi commands from Discord.
- `/sandi stop`: asks the current Sandi turn in this conversation to stop.
- `/sandi todo`: creates and pins an interactive todo list in the current channel
  or thread.
- `/sandi status`: reports runtime status, uptime/memory health, queue state,
  git revision, token usage, provider limits, and the current conversation's
  compiled context size when available.
- `/sandi events list`: lists scheduled events for the current conversation or
  all events, depending on the optional scope.
- `/sandi reminders list`: lists interactive human reminders for the current
  conversation or all reminders, depending on the optional scope.

The wrapper posts Pi stdout to Discord as Sandi's ordinary reply unless the turn
already used an explicit Discord send helper/tool. Explicit Discord sends record
a per-turn side-effect marker, and the wrapper suppresses the final-text post to
avoid duplicate messages. Long final replies are chunked for Discord delivery.

## Pi Contract

Persistent conversations call Pi with a stable shared session file under
`data/pi-sessions/`. One-off fallback mentions call Pi with `--no-session`.

When `data/config/pi-accounts.json` exists, persistent Discord turns are routed
by mapped human identity. Human turns fail closed when their mapped identity or
account auth is unavailable; Sandi does not route a human's prompt through
another human's ChatGPT/Codex subscription for missing auth, quota limits, or
rate limits. The durable transcript session remains shared by every participant
in that Discord conversation, but account routing is recomputed from the mapped
identity on each model turn and does not persist sticky account affinity between
turns.

Scheduled events are creator-owned model turns. Creating an event records the
mapped Discord identity that caused it; when the event fires, Sandi runs the
model as that creator for account routing while appending to the target
conversation's shared Pi session. Event JSON without `createdBy.identityId` is
invalid. Interactive reminders only send Discord reminder messages when they
fire, but reminder and todo reminder records still store creator identity.
Reminder follow-up messages are globally rate-limited to avoid noisy reminder
storms: repeated follow-ups are normalized to at least 60 minutes apart, and a
reminder that has already fired 3 times in a rolling 24-hour window is
rescheduled to the next allowed fire time instead of sending another ping. This
does not change the initial requested reminder time or explicit Done, Snooze,
and Delete controls.

Every Pi model turn logs a local account-routing audit record before execution
and a completion or failure record afterward. The audit fields include the
mapped identity id, configured Pi account id, provider, model, session mode,
and conversation id. The audit logs avoid prompt text, tokens, refresh tokens,
and account directory paths.

The model-visible metadata block also includes compact account-routing
provenance for provider-side request logs: the per-human account-routing policy,
the Discord user id and mapped identity that caused the turn, the source
(`discord_message_author` or `scheduled_event_creator`). It does not include
tokens or Pi account directory paths.

Default main turns use:

```sh
printf '%s' '<message>' | pi --print \
  --extension ./src/lib/pi-extension/js-run-tool.ts \
  --extension ./src/lib/pi-extension/memory-tools.ts \
  --extension ./src/lib/pi-extension/skill-tools.ts \
  --extension ./src/lib/pi-extension/policy-tools.ts \
  --extension ./src/lib/pi-extension/imagegen-tools.ts \
  --extension ./src/lib/pi-extension/stop-sentinel.ts \
  --extension ./src/lib/pi-extension/token-usage-recorder.ts \
  --system-prompt <short-notice> \
  --append-system-prompt <compiled-context-payload-file> \
  --session <conversation-session>
```

Before the Discord surface starts, Sandi runs `ensurePiRuntimeSetup`. That
preflight expects Pi `0.77.0`, reconciles packages from `config/pi-packages.json`,
removes blocked packages, writes Sandi-owned `pi-codex-conversion.json` into the
default Pi agent dir and every configured account agent dir, and verifies the
configured provider/model with `pi --offline --list-models`. The conversion
config enables provider-native Responses compaction, native converted file-edit
tools, native web search, cached websocket upgrade, and low verbosity. Codex
Conversion's `imagegen` tool is disabled so Sandi's richer `image_generate`
extension remains the image-generation path.
Main turns intentionally leave Pi extension discovery and builtin tools enabled
so installed conversion tools can load. Read-only nested memory/skill search
sessions still use `--no-extensions` and `--no-builtin-tools`.

`SANDI_PI_EXTENSIONS` can replace the default extension list. The stop extension
watches a conversation-scoped sentinel file and calls Pi's cooperative
`ctx.abort()` path when `/sandi stop` is used.

The default path is code-mode first: Sandi composes local capabilities by calling
`sandi_js_run` and importing helpers from the runtime import path owned by the
current surface. Discord turns use `./sandi/runtime.ts` for
Discord, events, reminders, maps, and other runtime APIs. Native Codex
conversion tools handle web search, file reads, and file edits directly when Pi
exposes them. Code-mode conventions and examples live in
[`code-mode.md`](code-mode.md).
Process stdout and stderr from `sandi_js_run` are wrapped as untrusted execution
evidence so external text cannot masquerade as instructions.

## Context Compiler

`ContextCompiler` builds the system prompt in this order:

1. `data/config/soul.md`, falling back to `config/soul.md`
2. Policy index from `data/config/policies/` merged with `config/policies/`
3. Discord-delivery hard contract
4. Source-grounding guidance that tells Sandi to prefer searching for factual or
   current public claims and to cite external sources with Markdown links
5. Runtime environment metadata: surface, working directory, data/config roots,
   code-mode runtime import, and optional `SANDI_ENVIRONMENT_HINT`
6. Conversation metadata and active participants
7. Memory overview and visible scratchpads
8. Guidance for skill tools
9. Each active participant's `profile.md` and `instructions.md`, when present

The compiler includes the effective skill index and short skill guidance from
`data/skills/`. When BM25-style ranking over the current turn text and skill
metadata/aliases finds a clear match, it also adds a small "Possible relevant
skills for this turn" hint that lists only names/descriptions and tells Sandi to
read a skill only if it actually applies. Detailed workflow guidance still lives
in individual skill files; Sandi reads those with `skill_read` when a task
matches. The compiler does not read legacy `config/skills/`, `skills.yaml`, or
`tools.yaml` files.

## Conversations

Conversation manifests live at:

```text
data/conversations/<target-id>/manifest.json
```

Each manifest stores:

- canonical Discord conversation ID
- conversation kind (`thread` or `channel`)
- guild and target channel/thread IDs
- title
- created and updated timestamps
- starter user ID
- active participants

The canonical ID format is:

```text
discord:<guild-id>:<parent-channel-id>:<thread-id>
discord:<guild-id>:<channel-id>:room
```

Sandi keeps an in-memory FIFO queue per conversation target so only one Pi turn
runs for that forum thread or standing channel room at a time.

## Memory

Memory lives under `data/memory/` and is normally accessed through logical refs.
The memory tools validate refs against the current turn context.

Memory areas:

- `system`
- `self`
- `household`
- `topics`
- `surfaces/discord/threads/<thread-id>`
- `surfaces/discord/channels/<channel-id>`
- `discord/<discord-user-id>`
- `github/<github-user-id>`

The compiled prompt includes `MEMORY.md` scratchpads for:

- system
- self
- household
- the current thread archive or standing channel room, when present
- active participants

Other Markdown memory files are reached through memory tools.

Main-turn memory tools:

- `memory_list`
- `memory_read`
- `memory_search`
- `memory_write`
- `memory_forget`

`memory_search` launches a no-session Pi subagent with only read-only memory
tools:

- `memory_find_files`
- `memory_read_file`
- `memory_grep`

Allowed memory refs are validated against the current turn context. Shared
scopes are `system`, `self`, `household`, and `topics`; surface conversation
memory is exposed through the current conversation's
`surfaces/discord/threads/<thread-id>` and
`surfaces/discord/channels/<channel-id>` scopes. User memory is limited to
active participants. System memory is for machine, sandbox, tooling, paths, and
runtime environment details.

## Skills

Skills live under `data/skills/` and are accessed through logical skill names.
The skill tools resolve the effective core plus current-surface skill set.

Skill areas:

- `core/builtin`
- `core/custom`
- `surfaces/<surface>/builtin`
- `surfaces/<surface>/custom`

Main-turn skill tools:

- `skill_list`
- `skill_read`
- `skill_search`
- `skill_write`
- `skill_delete`

`skill_search` launches a no-session Pi subagent with only read-only skill
tools:

- `skill_find_files`
- `skill_read_file`
- `skill_grep`

Reads and searches use the effective skill set for the current surface. For
Discord, precedence is Discord custom, Discord builtin, core custom, core
builtin. Skill writes default to the current surface when a surface context is
present; pass `scope: "core"` only for truly global instructions.

Custom skills are the default way for a live Sandi to preserve new durable
behavior. Checked-in builtin skills are starter/product defaults; changing them
is source maintenance rather than ordinary household customization.

Core builtin workflow skills currently include:

- `development-scripting`: development and scripting workflow for Sandi's
  sandbox, including `data/scripts` and `data/projects`.
- `google-maps`: Google Maps Places lookup and local place metadata.
- `image-generation`: image generation through the Pi harness.
- `pull-request`: pull request descriptions, review context, and testing
  evidence.
- `self-development`: Sandi self-modification workflow and separate-checkout
  discipline.
- `skill-creator`: creating and improving skills.
- `strict-typescript`: strict TypeScript implementation, review, and verification
  practices.
- `web-research`: native Codex web search and source-grounded answers.

Discord builtin workflow skills currently include:

- `discord-markdown`: Discord-native Markdown formatting, including headings,
  lists, quotes, code blocks, spoilers, subtext, masked links, and
  unfurl-suppressed source links.
- `discord-participation`: Discord conversation etiquette and participation
  judgment.
- `image-generation`: Discord image attachments, visual references, and posting
  generated image files back to Discord.
- `reminders`: interactive human reminders for Discord.
- `temporal-continuity`: follow-ups, scheduled events, and event turns.

## Web Research

Web research is provided by the Codex conversion extension's native web-search
tooling on the OpenAI Responses path. Sandi no longer exposes Exa-backed
code-mode helpers or an Exa Pi extension. Web-research workflow details live in
the builtin `web-research` skill, which Sandi can find through `skill_search`
and read with `skill_read`. The compiled context also includes always-on
source-grounding guidance: for factual or current public claims, Sandi should
prefer checking available web/search/page-reading tools and cite sources in the
visible reply using Markdown masked links.

On Discord, citations should normally render as inline masked links such as
`[source](<https://example.com>)` or as a compact `Sources:` line with masked
links. Wrapping URLs in angle brackets suppresses Discord's link unfurls.
Discord supports line-level subtext, but not native superscript citation syntax.

## Google Maps

Google Maps Places lookup is available through code-mode helpers in
`src/lib/runtime/sandi/maps.ts`:

- `maps.searchPlaces`
- `maps.placeDetails`

The helpers use `SANDI_GOOGLE_MAPS_API_KEY` or `GOOGLE_MAPS_API_KEY`. Workflow
guidance lives in the builtin `google-maps` skill.

## Policies

Operational policies live in `data/config/policies/` and `config/policies/`.
Private policies shadow public policies with the same ref.

The compiled prompt includes a policy index. Full policy text is available
through:

- `policy_list`
- `policy_read`

Current policy files:

- `memory-ritual.md`
- `temporal-continuity.md`

## Scheduled Events

Scheduled events live as JSON files under `data/events/`. Each event stores the
mapped Discord creator in `createdBy`, and event-triggered model turns route
account usage to that creator.

Event helpers are available through code mode in `src/surfaces/discord/runtime/events.ts`:

- `events.currentTime`
- `events.createEvent`
- `events.listScheduledEvents`
- `events.readScheduledEvent`
- `events.cancelEvent`

Supported event types:

- `immediate`: fires as soon as the watcher sees it, then deletes the file.
- `one-shot`: fires at a concrete ISO timestamp, then deletes the file.
- `periodic`: uses cron syntax plus an IANA timezone and persists until
  cancelled.

Events target Discord forum threads or standing channel rooms. When an event
fires, Sandi receives a synthetic scheduled-event turn in that target
conversation.

Temporal-continuity workflow details live in the builtin
`temporal-continuity` skill rather than the compiled system prompt.

## Discord Runtime Helper

Discord access is available through code-mode helpers in
`src/surfaces/discord/runtime/discord.ts`:

- `discord.listChannels`
- `discord.readChannelHistory`
- `discord.searchChannelHistory`
- `discord.getMessage`
- `discord.sendMessage`
- `discord.sendFile`
- `discord.sendImage`
- `discord.readAttachment`
- `discord.readImageAttachment`
- `discord.currentContext`

Sent-message mentions are suppressed by default unless the helper call explicitly
enables them. Successful send helpers record a side-effect marker so automatic
final-text posting is suppressed for that turn.

## Runtime State File Permissions

Sandi-owned runtime state files that may carry household context or credentials
are written owner-only (`0600`) when Sandi updates them: memory files, custom
skills, conversation manifests, scheduled events, reminders, and refreshed
Pi/OpenAI auth files.

## File Layout

```text
config/
  soul.md
  policies/
  identities/humans.example.json
  users/
    discord/<discord-user-id>/
      profile.md
      instructions.md
    github/<github-user-id>/
      profile.md
      instructions.md

data/
  config/
    soul.md
    policies/
    identities/humans.json
    users/
  conversations/<target-id>/manifest.json
  events/<event-id>.json
  projects/
  scripts/
  memory/
    system/
    self/
    household/
    discord/<discord-user-id>/
    github/<github-user-id>/
    topics/
    surfaces/
      discord/
        threads/<thread-id>/
        channels/<channel-id>/
  skills/
    core/
      builtin/<skill-name>/SKILL.md
      custom/<skill-name>/SKILL.md
    surfaces/
      discord/
        builtin/<skill-name>/SKILL.md
        custom/<skill-name>/SKILL.md
  pi-sessions/<safe-canonical-id>.jsonl
```
