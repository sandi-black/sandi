import { join, resolve } from "node:path";

import { type CoreConfig, loadCoreConfig, readEnv } from "@/lib/config/env";
import { defaultApiPairingsPath } from "@/lib/pairing/pairing-store";
import {
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_HOURS,
  DEFAULT_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_ATTACHMENT_RETENTION_DAYS,
} from "@/surfaces/api/attachments/policy";

const DEFAULT_API_HOST = "127.0.0.1";
const DEFAULT_API_PORT = 8787;

export type ApiConfig = {
  host: string;
  port: number;
  tokensPath: string;
  pairingsPath: string;
  attachmentQuotaBytes: number;
  attachmentRetentionMs: number;
  attachmentCleanupIntervalMs: number;
};

export type ApiAppConfig = CoreConfig & {
  api: ApiConfig;
};

export function loadApiConfig(dataDir: string): ApiConfig {
  return {
    host: readEnv(["SANDI_API_HOST"]) ?? DEFAULT_API_HOST,
    port: readPortEnv(["SANDI_API_PORT"], DEFAULT_API_PORT),
    tokensPath:
      readEnv(["SANDI_API_TOKENS_PATH"]) ??
      join(dataDir, "config", "api-tokens.json"),
    pairingsPath: defaultApiPairingsPath(dataDir),
    attachmentQuotaBytes: readPositiveIntegerEnv(
      "SANDI_ATTACHMENT_QUOTA_BYTES",
      DEFAULT_ATTACHMENT_QUOTA_BYTES,
    ),
    attachmentRetentionMs: readPositiveDurationEnv(
      "SANDI_ATTACHMENT_RETENTION_DAYS",
      DEFAULT_ATTACHMENT_RETENTION_DAYS,
      24 * 60 * 60 * 1_000,
    ),
    attachmentCleanupIntervalMs: readPositiveDurationEnv(
      "SANDI_ATTACHMENT_CLEANUP_INTERVAL_HOURS",
      DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_HOURS,
      60 * 60 * 1_000,
      2_147_483_647,
    ),
  };
}

export function loadApiAppConfig(): ApiAppConfig {
  const core = loadCoreConfig();
  return {
    ...core,
    pi: {
      ...core.pi,
      // The api surface runs hands-local: load the proxy tools that route file
      // and shell work to the caller's desktop, the response-stream extension
      // that pushes the answer back token by token, and the surface-specific
      // outbound attachment tools. The composed host shares this config across
      // surfaces; each extension gates itself from the turn environment.
      extensionPaths: [
        ...core.pi.extensionPaths,
        apiLocalExecExtensionPath(),
        apiLocalMcpExtensionPath(),
        apiResponseStreamExtensionPath(),
        apiAttachToReplyExtensionPath(),
        apiAttachDesktopFileToDiscordExtensionPath(),
      ],
    },
    api: loadApiConfig(core.paths.dataDir),
  };
}

function apiLocalExecExtensionPath(): string {
  return resolve(
    readEnv(["SANDI_PI_LOCAL_EXEC_EXTENSION"]) ??
      "src/surfaces/api/pi-extension/local-exec-tools.ts",
  );
}

function apiLocalMcpExtensionPath(): string {
  return resolve(
    readEnv(["SANDI_PI_LOCAL_MCP_EXTENSION"]) ??
      "src/surfaces/api/pi-extension/local-mcp-tools.ts",
  );
}

function apiResponseStreamExtensionPath(): string {
  return resolve(
    readEnv(["SANDI_PI_RESPONSE_STREAM_EXTENSION"]) ??
      "src/surfaces/api/pi-extension/response-stream.ts",
  );
}

function apiAttachToReplyExtensionPath(): string {
  return resolve(
    readEnv(["SANDI_PI_ATTACH_TO_REPLY_EXTENSION"]) ??
      "src/surfaces/api/pi-extension/attach-to-reply-tool.ts",
  );
}

function apiAttachDesktopFileToDiscordExtensionPath(): string {
  return resolve(
    readEnv(["SANDI_PI_DISCORD_DESKTOP_FILE_EXTENSION"]) ??
      "src/surfaces/api/pi-extension/attach-desktop-file-to-discord.ts",
  );
}

function readPortEnv(names: readonly string[], defaultValue: number): number {
  const value = readEnv(names);
  if (!value) return defaultValue;
  // Require a full decimal integer: `Number.parseInt` would accept trailing
  // junk like "8787junk" and silently bind the wrong port.
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${names[0]} must be a port between 0 and 65535`);
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${names[0]} must be a port between 0 and 65535`);
  }
  return parsed;
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = readEnv([name]);
  if (!value) return defaultValue;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function readPositiveDurationEnv(
  name: string,
  defaultValue: number,
  unitMs: number,
  maxMs: number = Number.MAX_SAFE_INTEGER,
): number {
  const units = readPositiveIntegerEnv(name, defaultValue);
  const milliseconds = units * unitMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > maxMs) {
    throw new Error(`${name} is too large`);
  }
  return milliseconds;
}
