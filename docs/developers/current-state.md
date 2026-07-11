# Sandi Current State

This document describes the repo as it works now. Runtime behavior is defined by
the code under `src/`, the config under `config/`, and file-backed state under
`data/`.

## Runtime

Sandi is a TypeScript multi-surface household agent with file-backed state and
the local `pi` command. The runtime is intentionally self-extending: a deployment
can replace the soul, policies, user config, memory, custom skills, runtime
helpers, and local state through the data directory while keeping the shared
source harness stable. Sandi reaches people through Discord (implemented with
`discord.js`), GitHub (from a normal GitHub user through the local `gh` CLI), and
a desktop/API surface that desktops pair to for hands-local execution. The
surface/core boundary is documented in
[`surfaces.md`](surfaces.md): surfaces own platform-specific event intake
and delivery, while `src/lib/...` owns shared Sandi continuity such as memory,
skills, policies, identity context, provider behavior, and reusable runtime
helpers.

The production entrypoint is the host (`src/host/index.ts`, run with
`npm start`). It composes every configured surface into one process and builds
the shared singletons once:

- `ConversationStore`, `PiCliClient`, and the embedding-index maintainer, shared
  by every surface so each human's conversations and account routing stay unified;
- `DeviceRegistry` and `ToolBroker`, shared so a desktop holds one device link
  and a turn from any surface can reach it by identity;
- a `SandiBot`, `GitHubBot`, and `ApiBot`, each with its own `ContextCompiler`
  bound to its surface context.

Each surface is gated independently: the API/device surface is on unless
`SANDI_API_ENABLED=false`, Discord starts when a bot token is present, and GitHub
starts when `SANDI_GITHUB_ENABLED=true`. The standalone entrypoints
(`src/surfaces/<surface>/index.ts`, run with `npm run dev:discord`, `dev:api`,
`dev:github`) still exist for isolated development, where no other surface and no
shared device links are present.

The Discord bot listens with the `Guilds`, `GuildMessages`, and privileged
`MessageContent` intents. It finds the configured Sandi forum channel by
`SANDI_FORUM_CHANNEL_ID`, or by `SANDI_FORUM_CHANNEL_NAME` when no ID is set. The
GitHub bot polls notifications with `gh api`, discovering Sandi's login from
`gh api /user` unless `SANDI_GITHUB_LOGIN` is configured.

## Discord Behavior

Sandi passively reads every non-bot message in the channels she can see. She is
not gated on being @-mentioned: instead, each message that is not already part of
a managed conversation is routed through a decision.

- Explicit @-mentions of Sandi and replies to one of her own messages always earn
  a response (they bypass the gate).
- Every other passively observed message runs through a cheap reply gate: a short
  no-session Pi turn (thinking off, ~30s timeout) that answers `RESPOND` or
  `IGNORE` given the message, its author, the channel name, and a few recent
  channel messages for context. The gate fails quiet, so gate errors, timeouts,
  or ambiguous output leave Sandi silent. This is what lets Sandi decline messages
  that were not actually directed at her. While the gate is deciding, Sandi sends
  the Discord typing indicator (no reaction fallback) so onlookers can tell she is
  weighing the message; an `IGNORE` verdict leaves no visible trace.
- Channels or threads listed in `data/discord/ignored-channels.json` are skipped
  entirely (before the managed-thread check and the gate) unless the message
  explicitly @-mentions Sandi. Replies to her and the passive gate do not wake her
  in an ignored channel. The file is optional and uses
  `{ "channels": [{ "id": "..." }] }`, where each `id` is a channel or thread ID;
  with no file present, nothing is ignored. The `/sandi ignore` command appends
  the current channel or thread to this file (and stops any running turn there),
  and `/sandi listen` removes it again, so the same denylist is both operator- and
  in-Discord-managed.

Once Sandi decides to engage, threads are created on demand rather than on every
message:

- Sandi message threads: when Sandi engages a top-level text channel message (via
  mention, reply, or a gate `RESPOND`) and that message is not already inside a
  thread, she creates a Discord thread from it at that point. The thread starts as
  `new thread`, then Sandi runs a short no-session Pi title turn with the normal
  configured model and low thinking to rename it from the starter message. The
  origin message is the first user prompt for a new persistent Pi session scoped
  to that thread. Later non-bot replies inside the thread trigger Sandi without
  requiring a mention or a gate check. Because the thread session is keyed by the
  Discord thread ID, the thread is created when Sandi commits to replying rather
  than at the exact moment her text is posted.
- Sandi forum posts: every non-bot message inside a Sandi forum thread becomes a
  persistent Pi turn for that forum conversation. The first response to a message
  replies to the triggering message.
- Automatic channel rooms: channels with dedicated automatic handling, such as
  `todo-` and `tasks-` channels, continue to use persistent channel
  conversations instead of creating per-message threads.
- One-off replies: when Sandi engages a message that is already inside a
  non-managed thread (or any context that is not a top-level conversation
  channel), she replies in place with a no-session Pi turn instead of nesting a
  new thread.

When available, Discord message and scheduled-event metadata includes the active
channel topic and thread parent-channel topic so Sandi can see room norms or
standing context without needing a separate history lookup. For thread message
turns, metadata also includes a small best-effort digest of recent thread
messages since Sandi's last visible reply, helping recover context from queued
human chatter or downtime without copying parent-channel transcripts.

When a new Discord user speaks in a persistent conversation, Sandi adds that user
to the conversation manifest. One-off reply handling remains the fallback for
Discord contexts that are not persistent conversation channels, including engaged
messages inside non-managed threads. Sandi sends typing indicators while Pi is
running.

Sandi has Discord application commands registered by `npm run commands:sync`:

- `/sandi help`: shows the available Sandi commands from Discord.
- `/sandi stop`: asks the current Sandi turn in this conversation to stop.
- `/sandi ignore`: stops the current turn and adds this channel or thread to the
  ignore list, so Sandi only responds there when she is @-mentioned.
- `/sandi listen`: removes this channel or thread from the ignore list, undoing a
  previous `/sandi ignore`.
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

## GitHub Behavior

The GitHub surface starts with `npm run dev:github` or `npm run start:github`.
It assumes `gh` is already authenticated as Sandi's GitHub user. Sandi is not a
GitHub App and does not require webhook settings.

For systemd deployments, the Discord and GitHub services should invoke the
checked-out `tsx` binary directly rather than using `npm run start` wrappers so
routine stop signals reach the Node process without `npm` reporting the service
as a failed signal exit.

The poller reads participating notifications and handles direct mention and
review-request notifications. For `mention`, the router fetches the latest issue
comment, PR comment, or review comment and verifies the body still contains
Sandi's `@login` before triggering a turn; this avoids acting on stale GitHub
notification reasons after unrelated later activity. For `review_requested`, it
checks issue events for a pull request review request addressed to Sandi. On a
fresh state file, startup ignores notifications updated at or before startup
unless `SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS=true` is set.

Each GitHub issue or pull request is a persistent Sandi conversation:

```text
github:<owner>/<repo>:issue:<number>
github:<owner>/<repo>:pull:<number>
```

The model-visible GitHub runtime import is still `./sandi/runtime.ts`, but for
GitHub turns it re-exports `github` helpers for reading PRs, issue comments,
review comments, changed files, diffs, posting comments, replying to review
comments, and creating PR reviews. Final assistant text is posted back to GitHub
when no explicit GitHub helper already delivered a response.

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

The composed host admits every surface through one provider capacity controller.
Standalone surface entrypoints use the same controller policy. The defaults run
at most 3 provider turns concurrently, retain at most 64 waiting turns globally,
and retain at most 8 waiting turns for one identity. Configure them with
`SANDI_PROVIDER_MAX_CONCURRENT`, `SANDI_PROVIDER_MAX_QUEUED`, and
`SANDI_PROVIDER_MAX_QUEUED_PER_IDENTITY`; use
`SANDI_PROVIDER_SHUTDOWN_GRACE_MS` to change the default 5-second shutdown grace.
Interactive work has first priority. After four consecutive interactive starts,
the oldest passive, background, or title job gets a slot so low-priority work
cannot starve. A compatible queued passive Discord gate is dropped, and title
generation is discarded when interactive work is waiting or the queue is at
least half full. New work beyond either queue limit is rejected explicitly.
Shutdown stops admission, rejects waiting work, and aborts active work after the
grace period.

The deterministic 100-turn burst verification admits 67 turns (3 active plus
the 64-slot queue), rejects 33, and observes a maximum of 3 active provider
turns. This evidence fixes the selected defaults to a bounded backlog with enough
headroom for a short multi-surface burst.

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

`SANDI_PI_EXTENSIONS` can replace the default extension list. The feedback
extension writes append-only memory/skill feedback events under
`SANDI_FEEDBACK_ROOT` so later review can distinguish useful, distracting, and
ignored retrieved resources. The stop extension watches a conversation-scoped
sentinel file and calls Pi's cooperative `ctx.abort()` path when `/sandi stop`
is used.

The default path is code-mode first: Sandi composes local capabilities by calling
`sandi_js_run` and importing helpers from the stable runtime import path
`./sandi/runtime.ts`. Every surface points that path at the same unified runtime
(`src/host/runtime/index.ts`), which re-exports Discord, GitHub, events,
reminders, todo, and maps helpers, so a turn from any surface can compose any of
them. Helpers used outside their native surface (for example posting to Discord
from a desktop turn) take an explicit target since there is no current channel or
thread. Native Codex conversion tools handle web search, file reads, and file
edits directly when Pi exposes them. Code-mode conventions and examples live in
[`code-mode.md`](code-mode.md).

Discord todo interactions and runtime helpers delegate item mutations to the
shared todo application core in `src/surfaces/discord/shared/todo-core.ts`. The
core serializes state changes, preserves per-list presentation settings, and owns
linked reminder creation, rescheduling, completion, and deletion. Adapters own
input parsing and Discord rendering; they do not write todo or reminder state
directly.

Process stdout and stderr from `sandi_js_run` are wrapped as untrusted execution
evidence so external text cannot masquerade as instructions.

## Context Compiler

`ContextCompiler` builds the system prompt in this order:

1. `data/config/soul.md`, falling back to `config/soul.md`
2. Policy index from `data/config/policies/` merged with `config/policies/`
3. active surface delivery hard contract
4. Source-grounding guidance that tells Sandi to prefer searching for factual or
   current public claims and to cite external sources with Markdown links
5. Runtime environment metadata: surface, working directory, data/config roots,
   code-mode runtime import, and optional `SANDI_ENVIRONMENT_HINT`
6. Conversation metadata and active participants
7. Memory overview, visible scratchpads, and dynamically suggested memory refs
   when hybrid retrieval finds prompt-relevant matches
8. Guidance for skill tools and dynamically suggested skill names when hybrid
   retrieval finds prompt-relevant matches
9. Each active participant's `profile.md` and `instructions.md`, when present

The compiler does not inject the full skill index. Instead, it tells Sandi how to
use `skill_search`, `skill_list`, and `skill_read`, then adds compact
"Potentially relevant skills to the prompt" hints only when the same hybrid
retrieval used by `skill_search` finds matches. It also adds "Potentially
relevant memories to the prompt" hints when memory retrieval finds matching refs.
Skill hints include the skill name, source, description, retrieval signals, and a
short matched passage reason. Memory hints include the memory ref, summary when
available, retrieval signals, and the matched passage label without injecting the
memory body. Full skill or memory content is loaded through tools. The compiler
does not read legacy
`config/skills/`, `skills.yaml`, or `tools.yaml` files.

## Conversations

Conversation manifests live at:

```text
data/conversations/<target-id>/manifest.json
```

Each manifest stores:

- canonical surface conversation ID
- conversation kind (`thread` or `channel`)
- surface-specific target IDs, such as Discord guild/channel/thread IDs or
  GitHub owner/repo/issue numbers
- title
- created and updated timestamps
- starter user ID
- active participants

The Discord canonical ID format is:

```text
discord:<guild-id>:<parent-channel-id>:<thread-id>
discord:<guild-id>:<channel-id>:room
```

The GitHub canonical ID format is:

```text
github:<owner>/<repo>:issue:<number>
github:<owner>/<repo>:pull:<number>
```

Sandi keeps an in-memory FIFO queue per conversation target so only one Pi turn
runs for that forum thread, Sandi message thread, automatic channel room, GitHub
issue, or GitHub pull request at a time.

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
- the current thread archive or automatic channel room, when present
- active participants

Other Markdown memory files are reached through memory tools. Prompt-time memory
suggestions list only potentially relevant refs and summaries, not full memory
files.

Main-turn memory tools:

- `memory_list`
- `memory_read`
- `memory_search`
- `memory_write`
- `memory_forget`

`memory_search` runs direct hybrid retrieval over allowed memory refs. It indexes
metadata plus Markdown passages, ranks passages with BM25 keyword scoring and
local embedding similarity, then aggregates passage matches back to logical
memory refs. Full memory content is still loaded through `memory_read`.

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

`skill_search` runs direct hybrid retrieval over the effective skill set. It
indexes skill metadata plus Markdown passages, ranks passages with BM25 keyword
scoring and local embedding similarity, then aggregates passage matches back to
skill names. Full skill text is still loaded through `skill_read`.

Reads and searches use the effective skill set for the current surface. For
Discord, precedence is Discord custom, Discord builtin, core custom, core
builtin. Skill writes default to the current surface when a surface context is
present; pass `scope: "core"` only for truly global instructions.

Custom skills are the default way for a live Sandi to preserve new durable
behavior. Checked-in builtin skills are starter/product defaults; changing them
is source maintenance rather than ordinary household customization.

## Semantic Retrieval

Memory and skill search use hybrid retrieval: BM25 for exact terms plus a local
CPU embedding model for semantic similarity. The default embedding configuration
is `SANDI_EMBEDDING_PROVIDER=local`,
`SANDI_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2`, `SANDI_EMBEDDING_DTYPE=q8`,
`SANDI_EMBEDDING_CACHE_DIR=./data/embedding-models`, and
`SANDI_EMBEDDING_BATCH_SIZE=24`. Set `SANDI_EMBEDDING_LOCAL_FILES_ONLY=true`
after the model is cached when runtime network access should be disabled. The
retrieval engine supports only the local embedding provider or disabled mode; if
the local model cannot load, search falls back to BM25-only results rather than
failing the turn.

Document embeddings are cached under `data/cache/embeddings/{skills,memory}`.
Each index has timestamped generation directories containing `manifest.json`
with the index version, source content hash, embedding engine, and counts, plus
`index.json` with passage embeddings. `current.json` points to the promoted
generation. On startup Sandi validates the skill and memory indexes separately;
missing, stale, wrong-version, or wrong-engine indexes rebuild in the background.
Long-running file watchers debounce source changes and promote a rebuilt
generation only after it is complete, so searches keep using the previous
generation until replacement. If no cache is available yet, search falls back to
on-demand passage scoring.

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

Events target Discord threads or standing channel rooms. When an event
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
