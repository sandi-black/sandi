# API Surface

The API surface lets a remote application talk to Sandi over HTTP while her
continuity (memory, skills, identity, policies, account routing, persistent Pi
sessions) stays in the server. It is the foundation for running Sandi as a
remote agent on the desktop, similar in feel to a local coding agent, but backed
by her shared brain rather than a fresh per-machine context.

Read [`surfaces.md`](surfaces.md) first: the surface/platform/shared-core split
it describes is what makes this possible. The API surface owns its HTTP intake
and delivery; everything that carries Sandi's continuity is reused unchanged
from `src/lib/...`.

## Why this exists

The Discord and GitHub surfaces authenticate Sandi (a bot token, a `gh` login)
and learn who a human is from the platform's trusted claims. A remote app
inverts that: Sandi is the server, and the caller must prove who they are. The
goal is that a household member can reach the same Sandi from a desktop app,
with the same memories and the same model account, through specific app flows
that off-the-shelf coding agents do not support.

The work is staged:

- Phase 1 (built): the server-side HTTP surface and authentication. Sandi
  reasons and runs her tools server-side, the caller is a thin client.
- Phase 2 (designed below, not yet built): hands-local execution, where Sandi's
  brain stays in the server but file and shell tools run on the caller's
  machine.
- Phase 3 (designed below): response streaming.
- A desktop GUI app is out of scope here; Phase 2 ships a minimal reference
  client instead.

## Identity and authentication

A bearer token authenticates a caller to an existing human identity. Tokens are
per device, so a lost laptop is revoked without rotating anything else.

The tokens file (default `data/config/api-tokens.json`, override with
`SANDI_API_TOKENS_PATH`) stores only hashes:

```json
{
  "version": 1,
  "tokens": [
    {
      "tokenSha256": "<sha256 of the raw token>",
      "identityId": "jess",
      "deviceId": "workstation",
      "label": "Jess workstation"
    }
  ]
}
```

The server hashes the presented bearer with SHA-256 and compares it against
every entry in constant time, so neither a match position nor the entry count
leaks through timing. The raw token is never written to disk by Sandi and never
logged. `npm run api:enroll` issues a token directly (for an operator): it
validates that the `identityId` exists in `humans.json`, appends a hashed entry
under the managed-write lock (see [`current-state.md`](current-state.md) for that
lock), and prints the raw token once.

### Pairing: self-service enrollment

Household members do not run the CLI. They enroll a device themselves, with an
identity-bearing surface acting as the mediator that proves who they are:

1. The member runs `/sandi auth` on a surface that already authenticates them
   (Discord today). Because this gate mints a credential, Sandi resolves them by
   their immutable platform account id only, never a mutable username, and fails
   closed if they are not on file (a member configured without an id cannot
   enroll until an operator adds it). It then issues a one-time pairing code and
   replies privately (ephemerally) with it.
2. The member pastes that code into their desktop client, which redeems it at
   `POST /v1/auth/pair`.
3. The server validates and atomically consumes the code, re-checks against a
   freshly reloaded `humans.json` that the bound identity still maps to a
   platform account (so a member removed after the code was issued is rejected
   without a server restart), mints a per-device bearer token, and returns it
   once. The client stores the token and uses it for every later turn.

The pairing store (`src/lib/pairing/pairing-store.ts`) is platform-neutral: it
records only the resolved `identityId`, never which surface issued the code. Because a token binds to an identity, and that identity already
carries both the Discord and GitHub mappings, pairing through Discord also
connects the member's GitHub account when one is on file, with no extra step.

Codes are short-lived (10 minutes), single-use, and stored only as SHA-256
hashes (default `data/config/api-pairings.json`, override with
`SANDI_API_PAIRINGS_PATH`). A code is 50 bits of Crockford base32 rendered as
two readable groups, with the ambiguous letters folded on redemption so a typo
of `O` for `0` still works. Issuing a new code supersedes the member's previous
unconsumed one, and expired codes are pruned on every write. Redemption runs
under the managed-write lock, so even two clients racing the same code mint at
most one token. The unauthenticated `POST /v1/auth/pair` is additionally rate
limited per client and globally as a flood guard.

Each pairing failure returns a terse status and mints no token: a malformed or
unknown code is `401`, a body with no code is `400`, an identity that no longer
maps to a platform account is `403`, and exceeding the rate limit is `429`.

### Identity reuse

A token carries an `identityId`, not a fresh account. At turn time Sandi
resolves that identity to the human's primary platform participant (Discord
first, else GitHub) from `humans.json`, and runs the turn as that participant.
The API turn therefore inherits that human's profile, instructions, personal
memory arena, and per-human account routing: one shared brain across surfaces.

The surface and the platform stay distinct, exactly as the surface contract
intends. The manifest records `surface: "api"`, while the participant `platform`
is the reused account (`discord` or `github`). No new `IdentityPlatform` value
is introduced.

Everything fails closed. A missing or malformed bearer is `401`. A valid token
whose identity is not in `humans.json`, or a human with no Discord or GitHub
mapping, is `403` before any model turn runs. Sandi never runs an unauthenticated
or unmapped turn, and never borrows another human's account.

## HTTP API (Phase 1)

The server is `node:http` (no added dependency) bound to `SANDI_API_HOST`
(default `127.0.0.1`) and `SANDI_API_PORT` (default `8787`). Start it with
`npm run start:api` (or `npm run dev:api`).

- `GET /v1/health` returns `200 { "ok": true, "surface": "api" }`. No auth.
- `POST /v1/auth/pair` redeems a pairing code (see above) for a per-device token.
  No bearer (the code is the proof). Body: `{ "code": string, "deviceId"?:
string, "label"?: string }`. On success: `200 { "surface": "api", "identityId",
"deviceId", "label", "token" }`, where `token` is the raw bearer, returned once.
  An omitted `deviceId` is generated server-side.
- `POST /v1/conversations/:conversationId/turns` requires a bearer token. Body:
  `{ "input": string, "title"?: string }`. On success: `200 { "conversationId",
"text" }` where `text` is Sandi's final Markdown reply.

Error responses are deliberately terse and leak no internal paths: `401`
(missing or invalid bearer), `403` (`identity_unmapped`), `400` (empty or
malformed body, or an invalid id segment), `413` (body over the size cap), and
`502`/`503` for provider failures (`503` for rate or quota limits).

### Conversation model

The client chooses a stable `conversationId` per session or thread. The
canonical id is:

```text
api:<identityId>:<deviceId>:<conversationId>
```

Each segment is validated against a strict alphabet (`^[A-Za-z0-9._-]{1,200}$`)
so two distinct inputs can never collapse to the same conversation or storage
id. The persistent Pi session is keyed by the canonical id, so reconnecting the
same device to the same `conversationId` resumes that session. Conversation
memory lives under the surface-scoped prefix
`surfaces/api/sessions/<conversationId>`.

### Turn lifecycle

A turn mirrors the GitHub surface. Each conversation has a slot in the shared
`ThreadQueue`, so only one turn runs per conversation at a time. The HTTP
response blocks on the queued turn until it completes. The turn compiles
instructions through `ContextCompiler`, calls the provider with
`accountRouting: { identityId }` and `surfaceContext: API_SURFACE_CONTEXT`, and
returns the final text. If the client disconnects, a request-scoped abort signal
is combined with the queue's signal so the in-flight turn is aborted rather than
left to burn a Pi session and write to a dead socket.

## Concurrency

This surface assumes one human runs many sessions and devices, concurrently with
Discord and GitHub. Two properties keep that safe:

- Per-conversation serialization through the `ThreadQueue`, as on every surface.
- Cross-process serialization of all writes to Sandi-managed state through the
  managed-write lock, so concurrent same-identity turns on different surfaces or
  devices cannot lose a memory or manifest update. Concurrent turns are separate
  OS processes sharing one `data/` directory, so this lock, not an in-process
  mutex, is what makes the shared brain safe under load.

## Phase 2: hands-local execution (designed, not built)

Phase 1 runs Sandi's tools server-side. Phase 2 keeps her brain, memory, and
identity in the server but runs file and shell tools on the caller's machine, so
she can work against the user's real projects. The execution model the owner
chose is that the session's workspace is the whole PC, run in bypass-permissions
mode (every operation allowed), matching how the household already runs local
agents.

### Transport and the tool broker

Hands-local needs the server to call back into the desktop mid-turn, so the
transport becomes a WebSocket the desktop opens outbound (no inbound path to the
desktop, so NAT and firewalls are not in the way). The desktop authenticates
with its per-device bearer token and registers its session.

Tool execution reaches the desktop through a per-turn broker, reusing the
existing coordination pattern. A Sandi turn already runs two process hops from
the server: the server spawns `pi --print`, and `sandi_js_run` spawns a further
`tsx` grandchild that imports the surface runtime barrel. Coordination flows down
through inherited environment variables (the delivery side-effect file and the
stop sentinel work exactly this way today). Phase 2 adds a loopback broker
address plus a per-turn token to that environment. The API runtime barrel's
`fs`, `shell`, and `process` helpers connect to the broker, which routes each
request to the exact desktop connection that owns the turn and relays the result
back. The desktop executes against its local machine and returns.

Two surface-scoped provider choices follow:

- Native Pi file-edit and file-read tools are disabled for this surface, since
  those operate on the server's disk (the wrong machine). All filesystem and
  shell work routes through the proxied helpers.
- Web search and research stay server-side.

Tool-call visibility comes for free: the desktop executes every file and shell
operation, so it sees each one as it happens, without a separate event channel.

### Routing, devices, and safety

- A turn binds to the specific device connection that owns its session, never to
  an identity in general, so a second desktop for the same human never receives
  another desktop's tool calls.
- An offline device fails closed: a turn whose session lives on a sleeping
  machine cannot run its tools and aborts through the existing stop path. The
  same property later enables cross-surface flows (ask from Discord, execute on
  an enrolled, online workstation).
- With bypass-all execution the enrollment token is the entire security
  boundary, so per-device tokens, transport encryption, and a server bound to a
  trusted interface carry the weight. An optional desktop-side never-touch
  denylist remains available even though approval prompts are off by default.

### Reference client

Phase 2 ships a minimal headless desktop client (connect, register a device,
execute proxied tool requests) so the surface is usable and verifiable end to
end. A full desktop GUI app remains a later, separate effort.

## Phase 3: streaming (designed, not built)

Phase 1 returns the final reply in one response, because the provider collects
`pi --print` stdout and returns it whole. A live coding-agent feel wants token
streaming and incremental tool-call narration. That is a change in the provider
layer (a streaming turn API) surfaced over Server-Sent Events or the Phase 2
WebSocket, and it is the only part of this vision that reaches outside the
surface.

## Files

```text
src/lib/pairing/
  pairing-store.ts              platform-neutral pairing-code store (issue/redeem)
  verify-pairing.ts             store-level verify (single-use, expiry, supersede)
src/surfaces/api/
  index.ts                      entrypoint and lifecycle
  config.ts                     loadApiAppConfig (host, port, tokens, pairings)
  auth/
    tokens.ts                   token store, hashing, verify, reload, mint
    enroll.ts                   api:enroll CLI
  api/
    conversations.ts            canonical ids and manifest builder
    delivery-instructions.ts    API delivery contract
  bot/
    api-bot.ts                  HTTP server, routing, auth, pairing, turns
    verify-api-bot.ts           verify harness with an injected provider
  runtime/
    context.ts                  API_SURFACE_CONTEXT
    index.ts                    runtime barrel (server-side helpers in Phase 1)
```

The pairing store lives under `src/lib/` (not the API surface) because the
issuing surface (Discord's `/sandi auth` handler) and the redeeming API surface
are separate processes that both write it, and shared core must not import a
surface. It binds only an `identityId`, so it stays surface-neutral.

Configuration lives in `.env.example` under the `SANDI_API_*` keys. The
`verify:api-bot` script proves health, auth rejection, unmapped-identity
fail-closed, identity routing, session reuse, token revocation, and the full
pairing redemption loop; `verify:pairing` proves the store's single-use,
expiry, supersede, and concurrency properties. Both run as part of `npm run
check`.
