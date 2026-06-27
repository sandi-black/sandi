# Systemd unit templates

These units are the recommended direct-host service definitions for Sandi.

They assume the standard direct-host layout:

- app checkout: `/srv/sandi/app`
- runtime environment file: `/srv/sandi/app/.env`
- Volta-managed Node on root's `PATH`
- checked-out `tsx` binary at `/srv/sandi/app/node_modules/.bin/tsx`

## Surface topology

`sandi.service` runs the **merged host** (`src/host/index.ts`), which composes
every enabled surface into a single process so a turn from any surface shares
the same conversation store, provider, and device links. By default that host
runs:

- the **API device surface**, an HTTP endpoint on `SANDI_API_HOST:SANDI_API_PORT`
  (default `127.0.0.1:8787`) that desktops pair to for hands-local execution; and
- the **Discord bot**, when `DISCORD_BOT_TOKEN` is set.

Because the host already serves the API surface, **do not add a separate API
service.** A standalone `npm run start:api` would bind the same `8787`, and the
host's resulting `EADDRINUSE` is an uncaught exception during startup that takes
the Discord surface down with it (the bot never reaches the gateway).

Toggle surfaces in `.env`:

- `SANDI_API_ENABLED=false`: disable the API surface (the host then runs Discord
  only).
- `SANDI_GITHUB_ENABLED=true`: fold the GitHub surface into the host process.

`sandi-github.service` is **optional**. The GitHub surface is poll-based and
binds no port, so it can run either:

- folded into the merged host via `SANDI_GITHUB_ENABLED=true` (keeps GitHub turns
  on the same shared device links as the other surfaces); or
- as this standalone unit, when you want GitHub to restart independently of
  Discord.

Run GitHub in exactly one place, never both.

## Install or refresh

```sh
sudo cp deploy/systemd/sandi.service /etc/systemd/system/sandi.service
# Optional, only if running GitHub as its own process:
sudo cp deploy/systemd/sandi-github.service /etc/systemd/system/sandi-github.service
sudo systemctl daemon-reload
sudo systemctl enable --now sandi.service
sudo systemctl enable --now sandi-github.service   # optional
```

If you previously ran a standalone `sandi-api.service`, retire it after switching
to the merged host so it stops contending for `8787`:

```sh
sudo systemctl disable --now sandi-api.service
sudo rm /etc/systemd/system/sandi-api.service
sudo systemctl daemon-reload
```

After changing unit files, restart services when ready:

```sh
sudo systemctl restart sandi.service
sudo systemctl restart sandi-github.service   # if installed
```

The units invoke `tsx` directly rather than using `npm run start` wrappers. This
keeps routine systemd stop signals aimed at the long-running Node process and
avoids npm reporting clean Sandi shutdowns as failed signal exits.
