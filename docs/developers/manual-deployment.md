# Manual Deployment

This guide covers running Sandi directly on a Linux host without Docker. It uses
one recommended direct-host layout:

- app checkout: `/srv/sandi/app`
- runtime data: `/srv/sandi/data`
- environment file: `/srv/sandi/app/.env`
- process supervisor: `systemd`
- app service: `sandi.service`
- optional update timer: `sandi-autopull.timer`
- optional data backup timer: `sandi-data-backup.timer`

Use Docker for the containerized path. Use this guide when the host should run
the Node process directly.

## Host Layout

Create separate app and runtime-data roots:

```sh
sudo mkdir -p /srv/sandi/app /srv/sandi/data /srv/sandi/backups
sudo chmod 755 /srv/sandi /srv/sandi/app /srv/sandi/data
```

The app checkout can be replaced, reset, or rebuilt. The data directory is
stateful and must be backed up. Keep these paths separate:

- `/srv/sandi/app`: Git checkout, source, package lock, checked-in config,
  checked-in assets, checked-in builtin skills.
- `/srv/sandi/data`: private config overlays, memory, conversations, events,
  reminders, custom skills, generated files, Discord attachments, Pi sessions,
  account routing, and other runtime state.
- `/srv/projects/<project>`: durable non-Sandi services hosted on the same box.

Do not put durable Sandi state only under the app checkout. A fresh deploy,
reset, or clone replacement should never delete `/srv/sandi/data`.

## Runtime Prerequisites

Install Git, rsync, and a recent Node runtime. Node 22 or newer is the baseline
used by CI and Docker. The examples below use Volta to install Node 24 and npm 11.

Example Volta setup:

```sh
curl https://get.volta.sh | bash
export PATH="$HOME/.volta/bin:$PATH"
volta install node@24 npm@11
```

Install OS tools used by deployment scripts:

```sh
sudo apt-get update
sudo apt-get install -y git rsync util-linux
```

On Ubuntu, `flock` is provided by `util-linux` and is usually already present.

## App Checkout

Clone the app into `/srv/sandi/app`:

```sh
sudo rm -rf /srv/sandi/app
sudo git clone git@github.com:sandi-black/sandi.git /srv/sandi/app
cd /srv/sandi/app
sudo npm install
sudo npm run check
```

If the service will run as a dedicated non-root user, run the install and later
commands as that user instead, and make sure `/srv/sandi/data` is writable by
the same user. The examples below run `sandi.service` as `root`, so the default
Pi account directory is `/root/.pi/agent`.

## Runtime Data

Create the runtime data directories Sandi expects:

```sh
sudo mkdir -p \
  /srv/sandi/data/config \
  /srv/sandi/data/conversations \
  /srv/sandi/data/discord-attachments \
  /srv/sandi/data/events \
  /srv/sandi/data/generated-images \
  /srv/sandi/data/js-runs \
  /srv/sandi/data/memory \
  /srv/sandi/data/pi-accounts \
  /srv/sandi/data/pi-sessions \
  /srv/sandi/data/projects \
  /srv/sandi/data/provider-usage \
  /srv/sandi/data/reactions \
  /srv/sandi/data/reminders \
  /srv/sandi/data/skills \
  /srv/sandi/data/tmp \
  /srv/sandi/data/todo-list
```

Sandi reads skills from `SANDI_SKILLS_ROOT`. In this deployment pattern,
`SANDI_SKILLS_ROOT=/srv/sandi/data/skills` so Sandi can write custom skills at
runtime. Checked-in builtin skills still come from the app checkout and should
be synced into the runtime skill root during install and update.

Initial builtin skill sync:

```sh
sudo mkdir -p /srv/sandi/data/skills/core/custom
sudo rsync -a --delete \
  /srv/sandi/app/data/skills/core/builtin/ \
  /srv/sandi/data/skills/core/builtin/

for surface_builtin in /srv/sandi/app/data/skills/surfaces/*/builtin; do
  [ -d "$surface_builtin" ] || continue
  surface="$(basename "$(dirname "$surface_builtin")")"
  sudo mkdir -p "/srv/sandi/data/skills/surfaces/$surface/custom"
  sudo rsync -a --delete \
    "$surface_builtin/" \
    "/srv/sandi/data/skills/surfaces/$surface/builtin/"
done
```

The sync overwrites only `builtin` directories. It does not overwrite `custom`
directories.

## Environment File

Create `/srv/sandi/app/.env` from the checked-in example:

```sh
cd /srv/sandi/app
sudo cp .env.example .env
sudo chmod 600 .env
```

Set the Discord secrets and IDs as usual. For the layout above, use these path
defaults:

```sh
SANDI_DATA_DIR=/srv/sandi/data
SANDI_CONFIG_DIR=./config
SANDI_EVENTS_ROOT=/srv/sandi/data/events
SANDI_REMINDERS_ROOT=/srv/sandi/data/reminders
SANDI_FEEDBACK_ROOT=/srv/sandi/data/feedback
SANDI_SKILLS_ROOT=/srv/sandi/data/skills
SANDI_JS_RUN_ROOT=/srv/sandi/data/js-runs
SANDI_PI_SESSION_DIR=/srv/sandi/data/pi-sessions
SANDI_TOKEN_USAGE_PATH=/srv/sandi/data/provider-usage/tokens.jsonl
```

If `pi` is available on `PATH`, the command can stay simple:

```sh
SANDI_PI_COMMAND=pi
SANDI_PI_PROVIDER=openai-codex
SANDI_PI_MODEL=gpt-5.5
SANDI_PI_THINKING=medium
```

For a more deterministic deploy, point Sandi at the package-locked Pi CLI:

```sh
SANDI_PI_COMMAND=/srv/sandi/app/node_modules/.bin/pi
```

Leave the `SANDI_PI_*_EXTENSION` variables unset for normal deployments. Sandi
derives the default Pi extension graph from the checked-out code so extension
paths move with the repository. Set an individual `SANDI_PI_JS_EXTENSION`,
`SANDI_PI_MEMORY_EXTENSION`, or similar variable only when debugging or testing a
custom extension path. Set `SANDI_PI_EXTENSIONS` only when intentionally
replacing the full default extension list.

Use `SANDI_ENVIRONMENT_HINT` to tell Sandi about the host boundary:

```sh
SANDI_ENVIRONMENT_HINT="This host is shared. Sandi owns /srv/sandi/app and /srv/sandi/data. Other durable projects live under /srv/projects/<project> unless explicitly named."
```

Private overlays belong under `/srv/sandi/data/config`, for example:

- `/srv/sandi/data/config/soul.md`
- `/srv/sandi/data/config/policies/*.md`
- `/srv/sandi/data/config/identities/humans.json`
- `/srv/sandi/data/config/pi-accounts.json`
- `/srv/sandi/data/config/users/...`

## Pi Authentication

Sandi shells out to Pi. It does not manage the browser login flow itself.

Authenticate the primary account as the same user that runs `sandi.service`.
For the root-run service pattern:

```sh
cd /srv/sandi/app
PI_CODING_AGENT_DIR=/root/.pi/agent \
PI_CODING_AGENT_SESSION_DIR=/srv/sandi/data/pi-sessions \
  /srv/sandi/app/node_modules/.bin/pi
```

Run Pi's `/login` flow and select the provider Sandi should use.

For routed secondary accounts, create an account directory under
`/srv/sandi/data/pi-accounts/<account-id>`, authenticate with
`PI_CODING_AGENT_DIR` pointed there, and map identities in
`/srv/sandi/data/config/pi-accounts.json`.

## Discord Commands

After `.env` is complete, sync Discord application commands:

```sh
cd /srv/sandi/app
npm run commands:sync
```

Run this again after deploys that change slash commands.

## Systemd Service

The repository includes direct-host unit templates under `deploy/systemd/`.
Install or refresh them with:

```sh
cd /srv/sandi/app
sudo cp deploy/systemd/sandi.service /etc/systemd/system/sandi.service
sudo cp deploy/systemd/sandi-github.service /etc/systemd/system/sandi-github.service
sudo systemctl daemon-reload
```

If you use a dedicated `sandi` user or a different Node installation, update the
copied units' `User`, `PATH`, `ExecStart`, and Pi account directories before
starting them.

The checked-in templates are equivalent to the examples below.

Create `/etc/systemd/system/sandi.service`:

```ini
[Unit]
Description=Sandi Discord AI bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/sandi/app
Environment=NODE_ENV=production
Environment=PATH=/root/.volta/bin:/root/.volta/tools/image/node/24.15.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/srv/sandi/app/.env
ExecStart=/srv/sandi/app/node_modules/.bin/tsx src/host/index.ts
Restart=always
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGINT
SuccessExitStatus=130

[Install]
WantedBy=multi-user.target
```

Use the checked-out `tsx` binary directly instead of `npm run start` in systemd
units. Systemd sends the stop signal to every process in the service control
group; when `npm` is the parent process, routine restarts can still be reported
as signal/error exits even when Sandi's Node process handles `SIGINT` or
`SIGTERM` cleanly.

Keep `SuccessExitStatus=130` in the units. Node/tsx can report an intentional
`SIGINT` shutdown as exit code 130 (`128 + SIGINT`) after Sandi's signal handler
has stopped surfaces cleanly; systemd should treat that specific code as a
normal restart/stop result.

For the optional GitHub polling surface, create a matching unit with the same
environment and this entrypoint:

```ini
ExecStart=/srv/sandi/app/node_modules/.bin/tsx src/surfaces/github/index.ts
```

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sandi.service sandi-github.service
sudo systemctl status sandi.service sandi-github.service --no-pager
```

Useful operations:

```sh
sudo journalctl -u sandi.service -f
sudo journalctl -u sandi-github.service -f
sudo systemctl restart sandi.service sandi-github.service
sudo systemctl stop sandi.service sandi-github.service
```

## Optional Autoupdate

An optional update timer can check the app repo, fast-forward only when the
worktree is clean and the branch has not diverged, refresh dependencies, verify
the checkout, sync Discord commands, sync builtin skills into
`/srv/sandi/data/skills`, and restart `sandi.service`.

Create `/usr/local/sbin/sandi-autopull`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo=/srv/sandi/app
service=sandi.service
lock=/run/sandi-autopull.lock
source_skills_root=/srv/sandi/app/data/skills
production_skills_root=/srv/sandi/data/skills
path_prefix=/root/.volta/bin:/root/.volta/tools/image/node/24.15.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

export PATH="$path_prefix"

log() {
  printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"
}

sync_builtin_skills() {
  if [[ -d "$source_skills_root/core/builtin" ]]; then
    log "syncing core builtin skills to production data directory"
    mkdir -p "$production_skills_root/core/builtin"
    rsync -a --delete "$source_skills_root/core/builtin/" "$production_skills_root/core/builtin/"

    if [[ -d "$source_skills_root/surfaces" ]]; then
      while IFS= read -r -d '' surface_builtin; do
        surface_dir="$(dirname "$surface_builtin")"
        surface="$(basename "$surface_dir")"
        target="$production_skills_root/surfaces/$surface/builtin"
        log "syncing $surface surface builtin skills to production data directory"
        mkdir -p "$target"
        rsync -a --delete "$surface_builtin/" "$target/"
      done < <(find "$source_skills_root/surfaces" -mindepth 2 -maxdepth 2 -type d -name builtin -print0)
    fi
    return 0
  fi

  log "no checked-in builtin skills directory found; skipping builtin skill sync"
}

exec 9>"$lock"
if ! flock -n 9; then
  log "another autopull is already running; skipping"
  exit 0
fi

cd "$repo"

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  log "repository is not on a branch; skipping"
  exit 0
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "$upstream" ]]; then
  log "branch $branch has no upstream; skipping"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "worktree has tracked local changes; skipping pull"
  git status --short
  exit 0
fi

before="$(git rev-parse HEAD)"

log "fetching $upstream"
git fetch --prune

remote="$(git rev-parse "$upstream")"
if [[ "$before" == "$remote" ]]; then
  log "already up to date at $before"
  exit 0
fi

base="$(git merge-base HEAD "$upstream")"
if [[ "$base" != "$before" ]]; then
  log "local branch has diverged from $upstream; skipping automatic pull"
  exit 0
fi

log "fast-forwarding $branch from $before to $remote"
git pull --ff-only

after="$(git rev-parse HEAD)"
if [[ "$after" == "$before" ]]; then
  log "pull completed without changing HEAD"
  exit 0
fi

log "refreshing npm dependencies"
npm install

log "running verification"
npm run check

if node -e 'const p = require("./package.json"); process.exit(p.scripts && p.scripts["commands:sync"] ? 0 : 1);'; then
  log "syncing Discord application commands"
  if ! npm run commands:sync; then
    log "Discord command sync failed; continuing with service restart"
  fi
fi

sync_builtin_skills

log "restarting $service"
systemctl restart "$service"

log "updated $service to $after"
```

Install it:

```sh
sudo chmod 755 /usr/local/sbin/sandi-autopull
```

Create `/etc/systemd/system/sandi-autopull.service`:

```ini
[Unit]
Description=Pull Sandi repo updates and restart daemon when changed
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sandi-autopull
```

Create `/etc/systemd/system/sandi-autopull.timer`:

```ini
[Unit]
Description=Poll Sandi git repo for updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=15s
Persistent=true
Unit=sandi-autopull.service

[Install]
WantedBy=timers.target
```

Enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sandi-autopull.timer
systemctl list-timers --all | grep sandi
```

Manual run:

```sh
sudo systemctl start sandi-autopull.service
sudo journalctl -u sandi-autopull.service --no-pager -n 100
```

## Optional Data Backup

A deployment can also keep a private Git backup of selected runtime identity
data from `/srv/sandi/data`. The backup should be whitelist-based: memory,
skills, events, reminders, todo lists, reactions, conversations, and small
metadata are backed up; generated images, attachments, Pi sessions, credentials,
browser state, scratch outputs, and project checkouts are excluded.

If using this pattern, initialize `/srv/sandi/data` as a private Git repository,
configure a private remote for that repository, then install a backup script like
this as `/usr/local/sbin/sandi-data-backup`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo=/srv/sandi/data
lock=/run/sandi-data-backup.lock
push_timeout=10m

keep_path() {
  case "$1" in
    .gitignore|.gitkeep|.version) return 0 ;;
    memory|memory/*) return 0 ;;
    skills|skills/*) return 0 ;;
    events|events/*) return 0 ;;
    reminders|reminders/*) return 0 ;;
    todo-list|todo-list/*) return 0 ;;
    reactions|reactions/*) return 0 ;;
    conversations|conversations/*) return 0 ;;
    *) return 1 ;;
  esac
}

exec 9>"$lock"
if ! flock -n 9; then
  exit 0
fi

cd "$repo"

cat > .gitignore <<'IGNORE'
*
!/.gitignore
!/.gitkeep
!/.version
!/memory/
!/memory/**
!/skills/
!/skills/**
!/events/
!/events/**
!/reminders/
!/reminders/**
!/todo-list/
!/todo-list/**
!/reactions/
!/reactions/**
!/conversations/
!/conversations/**
IGNORE

while IFS= read -r -d '' path; do
  if ! keep_path "$path"; then
    git rm -q --cached --ignore-unmatch -- "$path"
  fi
done < <(git ls-files -z)

for path in .gitignore .gitkeep .version memory skills events reminders todo-list reactions conversations; do
  if [[ -e "$path" ]]; then
    git add -A -- "$path"
  fi
done

if git diff --cached --quiet; then
  exit 0
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
git commit -m "Back up Sandi identity data ${timestamp}"
timeout "$push_timeout" git push
```

Example timer units:

```ini
# /etc/systemd/system/sandi-data-backup.service
[Unit]
Description=Back up Sandi runtime identity data
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sandi-data-backup
WorkingDirectory=/srv/sandi/data
```

```ini
# /etc/systemd/system/sandi-data-backup.timer
[Unit]
Description=Periodically back up Sandi runtime data

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
AccuracySec=1min
Persistent=true
Unit=sandi-data-backup.service

[Install]
WantedBy=timers.target
```

Enable it:

```sh
sudo chmod 755 /usr/local/sbin/sandi-data-backup
sudo systemctl daemon-reload
sudo systemctl enable --now sandi-data-backup.timer
```

## Deployment Checklist

Before considering the manual deployment live:

```sh
cd /srv/sandi/app
npm run check
npm audit --omit=dev
npm run commands:sync
sudo systemctl restart sandi.service
sudo systemctl status sandi.service --no-pager
sudo journalctl -u sandi.service --no-pager -n 100
```

Confirm these invariants:

- `/srv/sandi/app` is a clean Git checkout on the intended branch.
- `/srv/sandi/data` is outside the app checkout and backed up.
- `/srv/sandi/app/.env` is mode `600`.
- Pi auth exists for the service user and any routed accounts.
- `SANDI_DATA_DIR`, `SANDI_SKILLS_ROOT`, and `SANDI_PI_SESSION_DIR` point under
  `/srv/sandi/data`.
- `sandi.service` is enabled and active.
- Optional timers are enabled only after the first manual deploy succeeds.
