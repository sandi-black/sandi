import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { PiConfig } from "@/lib/config/env";
import { isMissingPathError } from "@/lib/fs-errors";
import { createLogger } from "@/lib/logging";
import { spawnCommandIgnoringStdin } from "@/lib/provider/spawn-command";

const log = createLogger("pi-setup");

const require = createRequire(import.meta.url);

const PackageJsonSchema = z.object({
  dependencies: z.object({
    "@earendil-works/pi-coding-agent": z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  }),
});

const packageJson = PackageJsonSchema.parse(require("../../../package.json"));

export const SUPPORTED_PI_VERSION =
  packageJson.dependencies["@earendil-works/pi-coding-agent"];

const PiPackageManifestSchema = z.object({
  packages: z.array(z.string().regex(/^(npm|git):/)).default([]),
  blockedPackages: z.array(z.string().regex(/^(npm|git):/)).default([]),
});

export type PiPackageManifest = z.infer<typeof PiPackageManifestSchema>;

const CODEX_CONVERSION_CONFIG_BASENAME = "pi-codex-conversion.json";

const SANDI_CODEX_CONVERSION_DEFAULTS = {
  mode: "normal",
  scope: {
    allProviders: false,
    additionalProviders: [],
  },
  tools: {
    webRun: true,
    imageGeneration: false,
    applyPatchOnly: false,
  },
  ui: {
    statusLine: false,
    toolRendering: true,
    backgroundShellWidget: true,
    backgroundShellToggleShortcut: "alt+w",
    backgroundShellPrevShortcut: "alt+q",
    backgroundShellNextShortcut: "alt+e",
    backgroundShellCloseShortcut: "alt+r",
  },
  compaction: {
    responsesCompaction: true,
  },
  openai: {
    fast: false,
    verbosity: "low",
    forceCachedWebSockets: true,
    webSearchModel: "gpt-5.4-mini",
    compactionModel: "gpt-5.5",
    compactionReasoning: "current",
  },
} satisfies Record<string, unknown>;

export type PiSetupCommandRequest = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type PiSetupCommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type PiSetupRunner = (
  request: PiSetupCommandRequest,
) => Promise<PiSetupCommandResult>;

export type CodexConversionConfigSyncResult = {
  path: string;
  changed: boolean;
};

export type PiRuntimeSetupResult = {
  installed: string[];
  alreadyInstalled: string[];
  removed: string[];
  codexConversionConfigs: CodexConversionConfigSyncResult[];
};

export async function loadPiPackageManifest(
  path: string,
): Promise<PiPackageManifest> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return PiPackageManifestSchema.parse(parsed);
}

export function parseInstalledPiPackages(stdout: string): Set<string> {
  const packages = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("npm:") || trimmed.startsWith("git:")) {
      packages.add(trimmed);
    }
  }
  return packages;
}

export async function ensurePiRuntimeSetup(
  config: PiConfig,
  options?: {
    manifest?: PiPackageManifest;
    runner?: PiSetupRunner;
    timeoutMs?: number;
  },
): Promise<PiRuntimeSetupResult> {
  const manifest =
    options?.manifest ??
    (await loadPiPackageManifest(config.packageManifestPath));
  const runner = options?.runner ?? runSetupCommand;
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;

  await mkdir(config.sessionDir, { recursive: true });
  await verifyPiVersion({ config, runner, timeoutMs });

  const aggregate: PiRuntimeSetupResult = {
    installed: [],
    alreadyInstalled: [],
    removed: [],
    codexConversionConfigs: [],
  };

  for (const agentDir of setupAgentDirs(config)) {
    await mkdir(agentDir, { recursive: true });
    aggregate.codexConversionConfigs.push(
      await syncCodexConversionConfig(agentDir),
    );

    const env = buildPiSetupEnv(config, agentDir);
    const listResult = await runner({
      command: config.command,
      args: ["list"],
      env,
      timeoutMs,
    });
    requireCommandOk(listResult, "pi list");

    const installedSources = parseInstalledPiPackages(listResult.stdout);
    const blocked = manifest.blockedPackages.filter((source) =>
      installedSources.has(source),
    );
    for (const source of blocked) {
      const removeResult = await runner({
        command: config.command,
        args: ["remove", source],
        env,
        timeoutMs,
      });
      requireCommandOk(removeResult, `pi remove ${source}`);
      installedSources.delete(source);
      aggregate.removed.push(source);
    }

    const missing = manifest.packages.filter(
      (source) => !installedSources.has(source),
    );
    for (const source of missing) {
      const installResult = await runner({
        command: config.command,
        args: ["install", source],
        env,
        timeoutMs,
      });
      requireCommandOk(installResult, `pi install ${source}`);
      aggregate.installed.push(source);
    }

    aggregate.alreadyInstalled.push(
      ...manifest.packages.filter((source) => installedSources.has(source)),
    );
  }

  await verifyModelListing({
    config,
    runner,
    timeoutMs,
    agentDir: defaultPiAgentDir(config),
  });

  log.info("pi setup complete", {
    requiredPackages: manifest.packages.length,
    blockedPackages: manifest.blockedPackages.length,
    installedPackages: aggregate.installed.length,
    alreadyInstalledPackages: aggregate.alreadyInstalled.length,
    removedPackages: aggregate.removed.length,
    codexConversionConfigs: aggregate.codexConversionConfigs.length,
    packageDir: config.packageDir ?? "(pi default)",
  });

  return aggregate;
}

export async function syncCodexConversionConfig(
  agentDir: string,
): Promise<CodexConversionConfigSyncResult> {
  const configPath = join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
  const serialized = `${JSON.stringify(
    SANDI_CODEX_CONVERSION_DEFAULTS,
    null,
    2,
  )}\n`;
  const current = await readTextIfExists(configPath);
  const changed = current !== serialized;
  if (changed) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, serialized, "utf8");
  }
  return {
    path: configPath,
    changed,
  };
}

function setupAgentDirs(config: PiConfig): string[] {
  const dirs = new Set<string>([defaultPiAgentDir(config)]);
  for (const account of config.accountRouting?.accounts ?? []) {
    dirs.add(account.agentDir ?? defaultPiAgentDir(config));
  }
  return [...dirs];
}

function defaultPiAgentDir(config: PiConfig): string {
  return config.agentDir ?? join(homedir(), ".pi", "agent");
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function buildPiSetupEnv(
  config: PiConfig,
  agentDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: config.sessionDir,
  };
  if (config.packageDir) {
    env["PI_PACKAGE_DIR"] = config.packageDir;
  }
  const sandiOpenAiKey = process.env["SANDI_OPENAI_API_KEY"]?.trim();
  if (sandiOpenAiKey) {
    env["OPENAI_API_KEY"] = sandiOpenAiKey;
  }
  return env;
}

async function verifyPiVersion(params: {
  config: PiConfig;
  runner: PiSetupRunner;
  timeoutMs: number;
}): Promise<void> {
  const result = await params.runner({
    command: params.config.command,
    args: ["--version"],
    env: buildPiSetupEnv(params.config, defaultPiAgentDir(params.config)),
    timeoutMs: params.timeoutMs,
  });
  requireCommandOk(result, "pi --version");
  const actualVersion = (result.stdout.trim() || result.stderr.trim()).trim();
  if (actualVersion !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `Unsupported Pi version ${actualVersion}. Sandi expects ${SUPPORTED_PI_VERSION}.`,
    );
  }
}

async function verifyModelListing(params: {
  config: PiConfig;
  runner: PiSetupRunner;
  timeoutMs: number;
  agentDir: string;
}): Promise<void> {
  const args = ["--offline"];
  if (params.config.provider) args.push("--provider", params.config.provider);
  args.push("--list-models");
  if (params.config.model) args.push(params.config.model);

  const result = await params.runner({
    command: params.config.command,
    args,
    env: buildPiSetupEnv(params.config, params.agentDir),
    timeoutMs: params.timeoutMs,
  });
  requireCommandOk(result, "pi --offline --list-models");
}

function requireCommandOk(
  result: PiSetupCommandResult,
  description: string,
): void {
  if (result.ok) return;
  throw new Error(
    `${description} failed with exit code ${
      result.exitCode ?? "unknown"
    }: ${result.stderr || result.stdout}`,
  );
}

function runSetupCommand(
  request: PiSetupCommandRequest,
): Promise<PiSetupCommandResult> {
  return new Promise((resolve) => {
    const child = spawnCommandIgnoringStdin(request.command, request.args, {
      env: request.env,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdout.join(""),
        stderr: error.message,
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}
