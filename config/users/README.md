# User Config

Sandi is designed to become specific to the people who share a deployment. User
config is the durable, reviewable layer for that specificity: profiles describe
who a person is to Sandi, and instructions describe how Sandi should work with
that person.

Create one folder per platform user:

```text
config/users/discord/1234567890/
  profile.md
  instructions.md

config/users/github/22222222/
  profile.md
  instructions.md
```

For private deployments, put live user config under `data/config/users/...`.
Sandi reads `data/config` before the checked-in `config` directory and falls
back per file when a private copy is absent.

Sandi merges the config for everyone participating in a conversation. Runtime
memory is stored under platform arenas such as
`data/memory/discord/<discord-user-id>/` and `data/memory/github/<github-user-id>/`.
Shared memory remains under `system`, `self`, `household`, `topics`, `threads`,
and `channels`.

Use private `data/config/users/...` files for live household details, names,
preferences, accessibility needs, standing agreements, and relationship texture
that should not be published with the repo. Keep checked-in examples helpful
enough to show the shape without exposing real people.

Known cross-platform humans are mapped in
`data/config/identities/humans.json` or, for non-private deployments,
`config/identities/humans.json`.

`profile.md` and `instructions.md` are read into the compiled prompt. User
memory is only exposed for active conversation participants.
