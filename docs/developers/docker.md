# Docker

Sandi ships as a production Docker image that runs the Discord surface with the
same Pi-backed runtime used in local development. The image contains the app
source, checked-in config defaults, assets, and builtin skills. Runtime state,
private config overlays, Discord attachments, generated files, Pi sessions, Pi
auth, and Pi packages live under `/app/data`.

`/app/data` is declared as a Docker volume in the image, and the container
entrypoint refuses to start unless `SANDI_DATA_DIR` is backed by a Docker volume
or bind mount. Use `SANDI_ALLOW_EPHEMERAL_DATA=1` only for disposable tests.

## Build Locally

```sh
docker build -t sandi .
```

The Docker build runs `npm run typecheck` in a check stage, then creates a
runtime image with production dependencies only. `tsx` is a production
dependency because Sandi executes TypeScript entrypoints and runtime helper
scripts directly.

## Run Locally

Create `.env` from `.env.example` and fill the Discord settings first.

```sh
docker compose up -d
```

The compose file uses the published GHCR image by default and can also build
from the local checkout. It mounts the named `sandi-data` volume at `/app/data`
so Sandi's memory, conversations, Pi sessions, and private overlays survive
container replacement.

For a one-off local image run:

```sh
docker run --rm \
  --env-file .env \
  --volume sandi-data:/app/data \
  ghcr.io/sandi-black/sandi:latest
```

Do not omit the named volume for a real deployment. Dockerfile `VOLUME`
metadata creates an anonymous volume for plain `docker run`, which survives
ordinary container restarts but is easy to orphan and is deleted by
`docker run --rm` when no named volume or bind mount is provided.

## Runtime Data

The image ships checked-in builtin skills under `/app/bundled-data/skills`. On
startup, Sandi refreshes only the builtin skill layers inside `/app/data/skills`
from that image path. Runtime custom skills stay in the persistent data volume
under the matching `custom` directories and are not overwritten by image
updates.

Recommended production data layouts:

```sh
# Named volume, used by compose.yaml.
docker volume create sandi-data

# Or an explicit host directory.
docker run --rm \
  --env-file .env \
  --volume /srv/sandi/data:/app/data \
  ghcr.io/sandi-black/sandi:latest
```

Useful inspection and backup commands:

```sh
docker volume inspect sandi-data
docker compose exec sandi tar -czf - -C /app data > sandi-data-backup.tgz
docker run --rm --volume sandi-data:/data alpine tar -czf - -C /data . > sandi-data-backup.tgz
```

## Pi Authentication

The container defaults Pi state into `/app/data/pi-agent`,
`/app/data/pi-packages`, and `/app/data/pi-sessions`. Authenticate Pi inside the
same data volume before starting Sandi in production:

```sh
docker compose run --rm sandi pi
```

Run Pi's `/login` flow in that shell and select the provider Sandi should use.
Additional routed accounts can be authenticated by setting `PI_CODING_AGENT_DIR`
to the account directory declared in `data/config/pi-accounts.json`.

## GitHub Container Registry

The container workflow publishes to:

```text
ghcr.io/sandi-black/sandi
```

Publishing behavior:

- pull requests build the image without pushing it.
- pushes to `main` publish `main`, `sha-<short-sha>`, and `latest`.
- tags matching `v*.*.*` publish semantic version tags.
- images include OCI labels, provenance, SBOM output, and GitHub Actions cache.

The workflow uses the repository `GITHUB_TOKEN` with `packages: write`; no
separate registry token is required for publishing from this repository.
