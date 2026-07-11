# Sandi For Developers

These docs are for people building, deploying, operating, or extending Sandi.
They cover source layout, local setup, deployment options, runtime architecture,
Pi integration, code mode, surface boundaries, and verification.

Start here:

- [Developer guide](guide.md): local setup, project shape, Pi integration,
  runtime tools, config, data layout, and checks.
- [Docker deployment](docker.md): production image, persistent data volume, GHCR
  publishing, and container Pi authentication.
- [Manual deployment](manual-deployment.md): direct Linux/systemd deployment
  without Docker.

Architecture and runtime details:

- [Current state](current-state.md): detailed implementation notes for the
  current Discord surface and file-backed runtime.
- [Surface contract](surfaces.md): how interaction surfaces share Sandi's core
  runtime.
- [Code mode](code-mode.md): how Sandi composes local runtime helpers.
- [Browser sessions](browser-sessions.md): Browser Use profiles, private Discord
  handoff, cost limits, cleanup, and deployment configuration.
- [Host layout](host-layout.md): example shared-host boundaries for app, data,
  backups, and non-Sandi services.

For day-to-day interaction contracts and personalization, see
[Sandi for partners](../partners/README.md).
