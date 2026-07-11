import { resolve } from "node:path";

import { z } from "zod/v4";

const BrowserUseModelSchema = z.enum([
  "bu-mini",
  "bu-max",
  "bu-ultra",
  "gemini-3-flash",
  "claude-sonnet-4.6",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "gpt-5.4-mini",
]);

export type BrowserUseConfig = {
  apiKey: string;
  baseUrl?: string;
  statePath: string;
  model: z.infer<typeof BrowserUseModelSchema>;
  maxTaskCostUsd: number;
  maxSessionMinutes: number;
  maxConcurrentSessions: number;
  handoffTtlMs: number;
  reaperIntervalMs: number;
};

export function loadBrowserUseConfig(
  dataDir: string,
): BrowserUseConfig | undefined {
  const apiKey = readEnv(["SANDI_BROWSER_USE_API_KEY", "BROWSER_USE_API_KEY"]);
  const enabled = readBooleanEnv(
    ["SANDI_BROWSER_USE_ENABLED"],
    apiKey !== undefined,
  );
  if (!enabled) return undefined;
  if (!apiKey) {
    throw new Error(
      "SANDI_BROWSER_USE_ENABLED requires SANDI_BROWSER_USE_API_KEY or BROWSER_USE_API_KEY",
    );
  }

  const baseUrl = readEnv(["SANDI_BROWSER_USE_BASE_URL"]);
  const config: BrowserUseConfig = {
    apiKey,
    statePath: resolve(
      readEnv(["SANDI_BROWSER_USE_STATE_PATH"]) ??
        `${dataDir}/browser-use/state.json`,
    ),
    model: BrowserUseModelSchema.parse(
      readEnv(["SANDI_BROWSER_USE_MODEL"]) ?? "bu-mini",
    ),
    maxTaskCostUsd: readPositiveDecimalEnv(
      "SANDI_BROWSER_USE_MAX_TASK_USD",
      0.25,
    ),
    maxSessionMinutes: readNumberEnv(
      ["SANDI_BROWSER_USE_MAX_SESSION_MINUTES"],
      30,
    ),
    maxConcurrentSessions: readNumberEnv(
      ["SANDI_BROWSER_USE_MAX_CONCURRENT_SESSIONS"],
      1,
    ),
    handoffTtlMs:
      readNumberEnv(["SANDI_BROWSER_USE_HANDOFF_MINUTES"], 10) * 60_000,
    reaperIntervalMs:
      readNumberEnv(["SANDI_BROWSER_USE_REAPER_SECONDS"], 30) * 1_000,
  };
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}

function readPositiveDecimalEnv(name: string, defaultValue: number): number {
  const raw = readEnv([name]);
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function readEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readBooleanEnv(
  names: readonly string[],
  defaultValue: boolean,
): boolean {
  const raw = readEnv(names);
  if (!raw) return defaultValue;
  const value = raw.toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${names[0]} must be true or false`);
}

function readNumberEnv(names: readonly string[], defaultValue: number): number {
  const raw = readEnv(names);
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${names[0]} must be a positive integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${names[0]} must be a positive integer`);
  }
  return value;
}
