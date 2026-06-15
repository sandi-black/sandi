# GitHub Surface

The GitHub surface lets Sandi run from a normal GitHub user account instead of
a GitHub App or bot account. It uses the already-authenticated `gh` CLI for auth
and API calls.

## Runtime Model

Start it with:

```sh
npm run dev:github
```

The surface polls the authenticated user's notifications with:

```sh
gh api /notifications
```

It currently handles:

- `mention`: a notification whose latest issue, PR, or review comment contains
  `@<SANDI_GITHUB_LOGIN>`.
- `review_requested`: a pull request notification with a `review_requested`
  event whose requested reviewer is Sandi's GitHub user.

GitHub notification reasons can persist after later activity. The router does
not trust `reason: "mention"` by itself; it fetches the latest comment and
checks that the comment body still mentions Sandi before enqueueing a turn.

On a fresh state file, the surface ignores notifications updated at or before
startup by default. Set `SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS=true` when
you intentionally want the first run to process already-unread eligible
notifications.

## Auth

Sandi does not store GitHub tokens. Run `gh auth login` before starting the
surface. The default `SANDI_GH_COMMAND=gh` can point at another compatible
wrapper if needed.

If `SANDI_GITHUB_LOGIN` is unset, the surface discovers Sandi's login with:

```sh
gh api /user
```

## Delivery

Each GitHub issue or pull request is a persistent Sandi conversation. If the Pi
turn returns final text and did not use a GitHub runtime helper, the harness
posts that text back to the PR or issue as a comment. Mentions on PR review
comments reply to that review comment.

Inside code mode, Sandi imports GitHub helpers from `./sandi/runtime.ts`:

```ts
import { github } from "./sandi/runtime.ts";

const pr = await github.getPullRequest();
const files = await github.listPullRequestFiles();
const diff = await github.getPullRequestDiff();
await github.createPullRequestReview({
  body: "Reviewed the requested scope. I found no blocking issues.",
  event: "COMMENT",
});
```

Explicit helper calls record a delivery side effect so the harness suppresses
the automatic final-text comment.

## Configuration

```env
SANDI_GH_COMMAND=gh
SANDI_GH_TIMEOUT_MS=120000
SANDI_GITHUB_LOGIN=sandi-witch
SANDI_GITHUB_POLL_INTERVAL_MS=60000
SANDI_GITHUB_MAX_NOTIFICATIONS=50
SANDI_GITHUB_NOTIFICATION_REASONS=mention,review_requested
SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS=false
```

`SANDI_GITHUB_LOGIN` is optional when `gh api /user` returns the Sandi account.
