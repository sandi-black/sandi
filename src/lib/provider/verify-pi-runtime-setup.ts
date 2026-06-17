import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { PiConfig } from "@/lib/config/env";
import type {
  PiSetupCommandRequest,
  PiSetupCommandResult,
} from "@/lib/provider/pi-runtime-setup";
import {
  ensurePiRuntimeSetup,
  parseInstalledPiPackages,
  SUPPORTED_PI_VERSION,
} from "@/lib/provider/pi-runtime-setup";

const CodexConversionConfigSchema = z
  .object({
    tools: z.object({
      webRun: z.literal(true),
      imageGeneration: z.literal(false),
      applyPatchOnly: z.literal(false),
    }),
    compaction: z.object({
      responsesCompaction: z.literal(true),
    }),
    openai: z.object({
      compactionModel: z.literal("gpt-5.5"),
      forceCachedWebSockets: z.literal(true),
      verbosity: z.literal("low"),
    }),
    ui: z.object({
      statusLine: z.literal(false),
    }),
  })
  .catchall(z.unknown());

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-pi-setup-"));

try {
  verifyPackageListParsing();
  await verifyPerAccountSetup(tempRoot);
  await verifyStaleConfigReplacement(tempRoot);
  await verifyUnsupportedVersionStopsEarly(tempRoot);
  console.log("Pi runtime setup verification passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function verifyPackageListParsing(): void {
  const installed = parseInstalledPiPackages(`User packages:
  npm:@howaboua/pi-codex-conversion
    /Users/example/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion
  git:sandi.local/example-package
    /Users/example/.pi/agent/git/sandi.local/example-package
`);
  assert(
    [...installed].join(",") ===
      "npm:@howaboua/pi-codex-conversion,git:sandi.local/example-package",
    "pi list package parser should return npm and git package sources",
  );
}

async function verifyPerAccountSetup(root: string): Promise<void> {
  const calls: PiSetupCommandRequest[] = [];
  const config = piConfig(root, "per-account", {
    accountDirs: ["primary-agent", "secondary-agent"],
    packageDir: "pi-packages",
  });
  const result = await ensurePiRuntimeSetup(config, {
    manifest: {
      packages: ["npm:@howaboua/pi-codex-conversion"],
      blockedPackages: ["npm:pi-dcp"],
    },
    runner: async (request) => {
      calls.push(request);
      const command = request.args.join(" ");
      if (command === "--version") return ok(SUPPORTED_PI_VERSION);
      if (command === "list") return ok("User packages:\n  npm:pi-dcp\n");
      if (command === "remove npm:pi-dcp") return ok();
      if (command === "install npm:@howaboua/pi-codex-conversion") {
        return ok();
      }
      if (
        command === "--offline --provider openai-codex --list-models gpt-5.5"
      ) {
        return ok("openai-codex/gpt-5.5\n");
      }
      return fail(`unexpected command: ${command}`);
    },
    timeoutMs: 500,
  });

  assert(
    calls.map((call) => call.args.join(" ")).join("|") ===
      [
        "--version",
        "list",
        "remove npm:pi-dcp",
        "install npm:@howaboua/pi-codex-conversion",
        "list",
        "remove npm:pi-dcp",
        "install npm:@howaboua/pi-codex-conversion",
        "list",
        "remove npm:pi-dcp",
        "install npm:@howaboua/pi-codex-conversion",
        "--offline --provider openai-codex --list-models gpt-5.5",
      ].join("|"),
    "setup should verify once, then reconcile default plus account agent dirs",
  );

  const installCalls = calls.filter(
    (call) =>
      call.args.join(" ") === "install npm:@howaboua/pi-codex-conversion",
  );
  assert(
    installCalls.every(
      (call) => call.env["PI_PACKAGE_DIR"] === join(root, "pi-packages"),
    ),
    "setup should forward the shared Pi package dir",
  );
  assert(
    new Set(installCalls.map((call) => call.env["PI_CODING_AGENT_DIR"]))
      .size === 3,
    "setup should install packages under every configured agent dir",
  );
  assert(
    result.codexConversionConfigs.length === 3,
    "setup should sync conversion config to default plus account dirs",
  );

  for (const item of result.codexConversionConfigs) {
    const codexConfig = await readCodexConversionConfig(item.path);
    assert(
      codexConfig.compaction.responsesCompaction,
      "Responses compaction is enabled",
    );
    assert(codexConfig.tools.webRun, "native web search is enabled");
    assert(
      !codexConfig.tools.imageGeneration,
      "Codex conversion imagegen should stay disabled",
    );
    assert(
      codexConfig.openai.compactionModel === "gpt-5.5",
      "compaction model should match Sandi's default model",
    );
    assert(
      codexConfig.ui.statusLine === false,
      "status line should stay hidden",
    );
  }
}

async function verifyStaleConfigReplacement(root: string): Promise<void> {
  const agentDir = join(root, "stale-agent");
  await mkdir(agentDir, { recursive: true });
  const codexConfigPath = join(agentDir, "pi-codex-conversion.json");
  await writeFile(
    codexConfigPath,
    `${JSON.stringify(
      {
        responsesCompaction: false,
        webSearch: false,
        compactionModel: "old-model",
        adapterProviders: ["legacy"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await ensurePiRuntimeSetup(piConfig(root, "stale", { agentDir }), {
    manifest: {
      packages: [],
      blockedPackages: [],
    },
    runner: async (request) => {
      const command = request.args.join(" ");
      if (command === "--version") return ok(SUPPORTED_PI_VERSION);
      if (command === "list") return ok("User packages:\n");
      if (
        command === "--offline --provider openai-codex --list-models gpt-5.5"
      ) {
        return ok("openai-codex/gpt-5.5\n");
      }
      return fail(`unexpected command: ${command}`);
    },
  });

  const parsed: unknown = JSON.parse(await readFile(codexConfigPath, "utf8"));
  const codexConfig = CodexConversionConfigSchema.parse(parsed);
  assert(
    codexConfig.compaction.responsesCompaction,
    "stale compaction should be replaced",
  );
  assert(codexConfig.tools.webRun, "stale web search should be replaced");
  assert(
    !codexConfig.tools.imageGeneration,
    "stale image generation should be disabled",
  );
  assert(
    !("adapterProviders" in codexConfig),
    "stale extension-only config keys should be removed",
  );
}

async function verifyUnsupportedVersionStopsEarly(root: string): Promise<void> {
  const calls: PiSetupCommandRequest[] = [];
  let rejected = false;
  try {
    await ensurePiRuntimeSetup(piConfig(root, "unsupported"), {
      manifest: {
        packages: ["npm:@howaboua/pi-codex-conversion"],
        blockedPackages: [],
      },
      runner: async (request) => {
        calls.push(request);
        return ok("0.76.0");
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("0.76.0");
  }
  assert(rejected, "unsupported Pi versions should be rejected");
  assert(
    calls.map((call) => call.args.join(" ")).join("|") === "--version",
    "unsupported Pi version should stop before package reconciliation",
  );
}

function piConfig(
  root: string,
  name: string,
  options?: {
    agentDir?: string;
    accountDirs?: string[];
    packageDir?: string;
  },
): PiConfig {
  const accountDirs = options?.accountDirs ?? [];
  return {
    command: "pi",
    provider: "openai-codex",
    model: "gpt-5.5",
    thinking: "high",
    packageManifestPath: join(root, name, "pi-packages.json"),
    sessionDir: join(root, name, "sessions"),
    tokenUsagePath: join(root, name, "token-usage.jsonl"),
    extensionPaths: [],
    timeoutMs: 1000,
    eventsRoot: join(root, name, "events"),
    remindersRoot: join(root, name, "reminders"),
    feedbackRoot: join(root, name, "feedback"),
    skillsRoot: join(root, name, "skills"),
    ...(options?.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options?.packageDir
      ? { packageDir: join(root, options.packageDir) }
      : {}),
    ...(accountDirs.length > 0
      ? {
          accountRouting: {
            accounts: accountDirs.map((dir) => ({
              id: dir.replace(/-agent$/u, ""),
              agentDir: join(root, dir),
            })),
            routes: accountDirs.map((dir) => ({
              identityId: dir.replace(/-agent$/u, ""),
              accountId: dir.replace(/-agent$/u, ""),
            })),
          },
        }
      : {}),
  };
}

function ok(stdout = ""): PiSetupCommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
  };
}

function fail(stderr: string): PiSetupCommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr,
  };
}

async function readCodexConversionConfig(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return CodexConversionConfigSchema.parse(parsed);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
