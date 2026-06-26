import { join } from "node:path";

import { type CoreConfig, loadCoreConfig, readEnv } from "@/lib/config/env";

const DEFAULT_API_HOST = "127.0.0.1";
const DEFAULT_API_PORT = 8787;

export type ApiConfig = {
  host: string;
  port: number;
  tokensPath: string;
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
  };
}

export function loadApiAppConfig(): ApiAppConfig {
  const core = loadCoreConfig();
  return {
    ...core,
    api: loadApiConfig(core.paths.dataDir),
  };
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
