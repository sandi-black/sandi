# Contributing

Sandi is an application, not an npm library. Contributions should improve the
actual bot experience, deployment safety, or maintainability of the running
system.

## Local Setup

Install dependencies:

```sh
npm install
```

Create local configuration:

```sh
cp .env.example .env
```

Fill the needed Discord and Pi settings, then run:

```sh
npm run commands:sync
npm run dev
```

## Working Style

- Fix root causes when they are in scope.
- Keep private data, secrets, Pi credentials, memory dumps, and deployment-only
  generated state out of commits.
- Update `.env.example` when adding configuration.
- Update docs when behavior, setup, operations, or user-visible commands change.
- Run `npm run check` before opening a PR.

## AI-Assisted Contributions

AI-assisted PRs are welcome. The human submitter is responsible for the change.

That means the submitter should understand the code, review generated output,
test it, and explain the intent in a clear and logical way. Do not submit a raw
dump of generated code that you cannot defend or maintain.

Maintainers may ask for simplification, tests, clearer rationale, or a smaller
behavioral surface before reviewing or merging AI-assisted work.

## Pull Requests

PRs should explain:

- Why the change exists.
- What behavior changed.
- Any operational or configuration impact.
- The verification performed, especially `npm run check`.

Include screenshots or Discord behavior notes when changing visible bot
interactions or assets.
