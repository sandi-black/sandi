import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import "dotenv/config";

import { z } from "zod";

import type { PiAccountRoutingConfig } from "@/lib/provider/pi-account-routing";
import {
  defaultPiImagegenExtensionPath,
  defaultPiJsRunExtensionPath,
  defaultPiMemoryExtensionPath,
  defaultPiPolicyExtensionPath,
  defaultPiSkillExtensionPath,
  defaultPiStopExtensionPath,
  defaultPiTokenUsageExtensionPath,
} from "@/lib/provider/pi-cli-client";

export type PiConfig = {
  command: string;
  model?: string;
  provider?: string;
  thinking?: string;
  agentDir?: string;
  packageDir?: string;
  packageManifestPath: string;
  sessionDir: string;
  tokenUsagePath: string;
  accountRouting?: PiAccountRoutingConfig;
  extensionPaths: string[];
  timeoutMs: number;
  eventsRoot: string;
  remindersRoot: string;
  skillsRoot: string;
};

export type PathConfig = {
  dataDir: string;
  configDir: string;
  privateConfigDir: string;
  configDirs: string[];
  eventsRoot: string;
  remindersRoot: string;
  skillsRoot: string;
};

export type CoreConfig = {
  pi: PiConfig;
  paths: PathConfig;
  environmentHint?: string;
};

export function readEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function requireEnv(names: readonly string[]): string {
  const value = readEnv(names);
  if (value) return value;
  throw new Error(
    `Missing required environment variable: ${names.join(" or ")}`,
  );
}

function readNumberEnv(names: readonly string[], defaultValue: number): number {
  const value = readEnv(names);
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${names[0]} must be a positive integer`);
  }
  return parsed;
}

function defaultRemindersRoot(dataDir: string): string {
  return resolve(dataDir, "reminders");
}

const PiAccountRoutingFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      displayName: z.string().min(1).optional(),
      agentDir: z.string().min(1).optional(),
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      thinking: z.string().min(1).optional(),
    }),
  ),
  routes: z.array(
    z.object({
      identityId: z.string().min(1),
      accountId: z.string().min(1),
    }),
  ),
});

const DATA_DIR_TOKEN = "$" + "{SANDI_DATA_DIR}";
const CONFIG_DIR_TOKEN = "$" + "{SANDI_CONFIG_DIR}";
const HOME_TOKEN = "$" + "{HOME}";

export function loadCoreConfig(): CoreConfig {
  const piModel = readEnv(["SANDI_PI_MODEL"]);
  const piProvider = readEnv(["SANDI_PI_PROVIDER"]);
  const piThinking = readEnv(["SANDI_PI_THINKING"]);
  const environmentHint = readEnv(["SANDI_ENVIRONMENT_HINT"]);
  const dataDir = resolve(readEnv(["SANDI_DATA_DIR"]) ?? "./data");
  const configDir = resolve(readEnv(["SANDI_CONFIG_DIR"]) ?? "./config");
  const privateConfigDir = resolve(dataDir, "config");
  const configDirs = uniqueResolvedPaths([privateConfigDir, configDir]);
  const piExtensionPaths = readExtensionPaths();
  const eventsRoot = resolve(
    readEnv(["SANDI_EVENTS_ROOT"]) ?? `${dataDir}/events`,
  );
  const remindersRoot = resolve(
    readEnv(["SANDI_REMINDERS_ROOT"]) ?? defaultRemindersRoot(dataDir),
  );
  const skillsRoot = resolve(
    readEnv(["SANDI_SKILLS_ROOT"]) ?? `${dataDir}/skills`,
  );
  const accountRouting = readPiAccountRoutingConfig({
    configDirs,
    dataDir,
  });

  const config: CoreConfig = {
    pi: {
      command: readEnv(["SANDI_PI_COMMAND"]) ?? "pi",
      packageManifestPath: resolve(
        readEnv(["SANDI_PI_PACKAGE_MANIFEST"]) ??
          `${configDir}/pi-packages.json`,
      ),
      sessionDir: resolve(
        readEnv(["SANDI_PI_SESSION_DIR"]) ?? `${dataDir}/pi-sessions`,
      ),
      tokenUsagePath: resolve(
        readEnv(["SANDI_TOKEN_USAGE_PATH"]) ??
          `${dataDir}/provider-usage/tokens.jsonl`,
      ),
      extensionPaths: piExtensionPaths,
      timeoutMs: readNumberEnv(["SANDI_PI_TIMEOUT_MS"], 3_600_000),
      eventsRoot,
      remindersRoot,
      skillsRoot,
    },
    paths: {
      dataDir,
      configDir,
      privateConfigDir,
      configDirs,
      eventsRoot,
      remindersRoot,
      skillsRoot,
    },
  };

  if (accountRouting) config.pi.accountRouting = accountRouting;
  if (piModel) config.pi.model = piModel;
  if (piProvider) config.pi.provider = piProvider;
  if (piThinking) config.pi.thinking = piThinking;
  const piAgentDir = readEnv(["SANDI_PI_AGENT_DIR"]);
  if (piAgentDir) config.pi.agentDir = resolve(piAgentDir);
  const piPackageDir = readEnv(["SANDI_PI_PACKAGE_DIR"]);
  if (piPackageDir) config.pi.packageDir = resolve(piPackageDir);
  if (environmentHint) config.environmentHint = environmentHint;

  return config;
}

function readExtensionPaths(): string[] {
  const explicit = readEnv(["SANDI_PI_EXTENSIONS"]);
  if (explicit) {
    return explicit
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => resolve(item));
  }

  const jsRunExtension = resolve(
    readEnv(["SANDI_PI_JS_EXTENSION"]) ?? defaultPiJsRunExtensionPath(),
  );
  const memoryExtension = resolve(
    readEnv(["SANDI_PI_MEMORY_EXTENSION"]) ?? defaultPiMemoryExtensionPath(),
  );
  const skillExtension = resolve(
    readEnv(["SANDI_PI_SKILL_EXTENSION"]) ?? defaultPiSkillExtensionPath(),
  );
  const policyExtension = resolve(
    readEnv(["SANDI_PI_POLICY_EXTENSION"]) ?? defaultPiPolicyExtensionPath(),
  );
  const imagegenExtension = resolve(
    readEnv(["SANDI_PI_IMAGEGEN_EXTENSION"]) ??
      defaultPiImagegenExtensionPath(),
  );
  const stopExtension = resolve(
    readEnv(["SANDI_PI_STOP_EXTENSION"]) ?? defaultPiStopExtensionPath(),
  );
  const tokenUsageExtension = resolve(
    readEnv(["SANDI_PI_TOKEN_USAGE_EXTENSION"]) ??
      defaultPiTokenUsageExtensionPath(),
  );
  return [
    jsRunExtension,
    memoryExtension,
    skillExtension,
    policyExtension,
    imagegenExtension,
    stopExtension,
    tokenUsageExtension,
  ];
}

function readPiAccountRoutingConfig(input: {
  configDirs: readonly string[];
  dataDir: string;
}): PiAccountRoutingConfig | undefined {
  const candidate = firstConfigFile(input.configDirs, "pi-accounts.json");
  if (!candidate || !existsSync(candidate.path)) return undefined;

  const parsed = PiAccountRoutingFileSchema.parse(
    JSON.parse(readFileSync(candidate.path, "utf8")),
  );
  const context = {
    configDir: candidate.configDir,
    dataDir: input.dataDir,
  };

  return {
    accounts: parsed.accounts.map((account) => {
      const normalized = {
        id: account.id,
      };
      return {
        ...normalized,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        ...(account.agentDir
          ? {
              agentDir: resolveConfigPath(
                expandConfigValue(account.agentDir, context),
                context.configDir,
              ),
            }
          : {}),
        ...(account.provider ? { provider: account.provider } : {}),
        ...(account.model ? { model: account.model } : {}),
        ...(account.thinking ? { thinking: account.thinking } : {}),
      };
    }),
    routes: parsed.routes.map((route) => ({
      identityId: route.identityId,
      accountId: route.accountId,
    })),
  };
}

function firstConfigFile(
  configDirs: readonly string[],
  filename: string,
): { path: string; configDir: string } | undefined {
  for (const configDir of configDirs) {
    const path = resolve(configDir, filename);
    if (existsSync(path)) return { path, configDir };
  }
  return undefined;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    const key =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function resolveConfigPath(value: string, configDir: string): string {
  if (isAbsolute(value)) return resolve(value);
  return resolve(configDir, value);
}

function expandConfigValue(
  value: string,
  input: {
    configDir: string;
    dataDir: string;
  },
): string {
  return value
    .replaceAll(DATA_DIR_TOKEN, input.dataDir)
    .replaceAll(CONFIG_DIR_TOKEN, input.configDir)
    .replaceAll(
      HOME_TOKEN,
      process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
    );
}
