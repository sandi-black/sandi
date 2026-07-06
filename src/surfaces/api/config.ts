import { join, resolve } from "node:path";

import { type CoreConfig, loadCoreConfig, readEnv } from "@/lib/config/env";
import { defaultApiPairingsPath } from "@/lib/pairing/pairing-store";

const DEFAULT_API_HOST = "127.0.0.1";
const DEFAULT_API_PORT = 8787;

export type ApiConfig = {
  host: string;
  port: number;
  tokensPath: string;
  pairingsPath: string;
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
      // that pushes the answer back token by token, and attach_to_reply for
      // outbound attachments. Loaded only here, so other surfaces never carry
      // them. Each self-disables (or, for attach_to_reply, answers a graceful
      // refusal) on any turn that did not lease a tool broker.
      extensionPaths: [
        ...core.pi.extensionPaths,
        apiLocalExecExtensionPath(),
        apiResponseStreamExtensionPath(),
        apiAttachToReplyExtensionPath(),
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
