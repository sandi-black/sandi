# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS base

WORKDIR /app

ENV NODE_ENV=production

FROM base AS check

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run typecheck

FROM base AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/app/node_modules/.bin:${PATH}" \
  SANDI_BUNDLED_SKILLS_ROOT="/app/bundled-data/skills" \
  SANDI_DATA_DIR="/app/data" \
  SANDI_CONFIG_DIR="/app/config" \
  SANDI_PI_COMMAND="/app/node_modules/.bin/pi" \
  SANDI_PI_AGENT_DIR="/app/data/pi-agent" \
  SANDI_PI_PACKAGE_DIR="/app/data/pi-packages" \
  SANDI_PI_SESSION_DIR="/app/data/pi-sessions" \
  SANDI_TOKEN_USAGE_PATH="/app/data/provider-usage/tokens.jsonl"

COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
  && npm cache clean --force

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node LICENSE NOTICE ./
COPY --chown=node:node LICENSES ./LICENSES
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY --chown=node:node assets ./assets
COPY --chown=node:node data/skills ./bundled-data/skills
COPY docker/entrypoint.sh /usr/local/bin/sandi-docker-entrypoint

RUN mkdir -p \
    /app/data/config \
    /app/data/conversations \
    /app/data/discord-attachments \
    /app/data/events \
    /app/data/generated-images \
    /app/data/js-runs \
    /app/data/memory \
    /app/data/pi-accounts \
    /app/data/pi-agent \
    /app/data/pi-packages \
    /app/data/pi-sessions \
    /app/data/projects \
    /app/data/provider-usage \
    /app/data/reminders \
  && chown -R node:node /app/data /app/bundled-data \
  && chmod 755 /usr/local/bin/sandi-docker-entrypoint

USER node

VOLUME ["/app/data"]

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/sandi-docker-entrypoint"]
CMD ["node", "--import", "tsx", "src/host/index.ts"]
