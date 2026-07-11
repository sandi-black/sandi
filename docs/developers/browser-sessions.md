# Browser Sessions

Sandi uses the official Browser Use SDK for authenticated or interactive web
work. Public research stays on Pi's native web-search and page-reading tools.

## Lifecycle

`browser_session_start` creates or reuses a named provider profile, starts one
kept-alive browser session, and runs the first task. The tool returns the task
result, cost, and Sandi session ID. It never returns the provider live URL.

When a human must log in, approve a payment, use a passkey, or complete another
sensitive step, Sandi calls `browser_session_handoff`. Discord posts a neutral
public button addressed to that human. Clicking it opens an ephemeral message
containing the short-lived browser link, the handoff reason, and Continue and
Cancel buttons.

- Continue marks the session idle and queues a synthetic turn in the same Sandi
  conversation. Sandi resumes it with `browser_session_continue`.
- Cancel stops the provider session, saves the profile, and queues a synthetic
  cancellation turn.
- `browser_session_stop` explicitly stops a completed session and saves its
  profile state.

Sessions also close after the configured lifetime, when a handoff expires, when
a browser task fails, or during a graceful host shutdown. The periodic reaper
handles expiration after restarts.

## Security boundary

Profiles and sessions belong to a mapped Sandi identity. Continuation requires
the same identity and conversation. Discord handoff actions additionally require
the Discord user who requested the handoff.

The provider API key and live URL are excluded from model-visible tool results
and `data/browser-use/state.json`. The live URL is fetched only while answering
an authorized Discord button interaction. Browser task prompts must not contain
passwords, card details, API keys, or other secrets; the human enters sensitive
values through the private browser.

Browser Use recording, scheduled tasks, skills, agent mail, and code mode are
disabled for Sandi sessions.

## Configuration

Set `SANDI_BROWSER_USE_API_KEY` or `BROWSER_USE_API_KEY` to enable the feature.
`SANDI_BROWSER_USE_ENABLED=false` disables it even when a key is present.

Defaults favor bounded free-tier testing:

| Variable                                    | Default                                    | Purpose                                  |
| ------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `SANDI_BROWSER_USE_MODEL`                   | `bu-mini`                                  | Provider browser model                   |
| `SANDI_BROWSER_USE_MAX_TASK_USD`            | `0.25`                                     | Provider cost ceiling for each task call |
| `SANDI_BROWSER_USE_MAX_SESSION_MINUTES`     | `30`                                       | Hard lifetime for an open session        |
| `SANDI_BROWSER_USE_MAX_CONCURRENT_SESSIONS` | `1`                                        | Open sessions allowed per identity       |
| `SANDI_BROWSER_USE_HANDOFF_MINUTES`         | `10`                                       | Private handoff lifetime                 |
| `SANDI_BROWSER_USE_REAPER_SECONDS`          | `30`                                       | Expiration sweep interval                |
| `SANDI_BROWSER_USE_STATE_PATH`              | `${SANDI_DATA_DIR}/browser-use/state.json` | Local lifecycle metadata                 |

`SANDI_BROWSER_USE_BASE_URL` exists for tests and compatible gateways. Production
deployments should use the SDK default. `SANDI_PI_BROWSER_EXTENSION` can override
the in-repo Pi extension path. A complete `SANDI_PI_EXTENSIONS` override must
include `src/lib/pi-extension/browser-tools.ts` explicitly.

Keep the API key in the deployment secret store, never in checked-in config.
The state file belongs on Sandi's persistent data volume so cleanup and profile
ownership remain coherent across restarts.

## Verification

Run `npm run verify:browser-use` for the local contract test. It drives the real
SDK against a local fake provider and verifies profile reuse, task continuation,
cost and concurrency limits, private URL ownership, explicit cleanup, expiry
cleanup, and secret-free state. `npm run check` includes this verifier and the Pi
extension load smoke test.
