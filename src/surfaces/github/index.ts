import { resolve } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { createLogger } from "@/lib/logging";
import { migrateDataDir } from "@/lib/migrations/data-dir";
import { PiCliClient } from "@/lib/provider/pi-cli-client";
import { ensurePiRuntimeSetup } from "@/lib/provider/pi-runtime-setup";
import { startEmbeddingIndexMaintenance } from "@/lib/retrieval/embedding-index-maintenance";
import { GitHubBot } from "@/surfaces/github/bot/github-bot";
import { loadGitHubAppConfig } from "@/surfaces/github/config";
import { GitHubApi } from "@/surfaces/github/github/api";
import { GhCli } from "@/surfaces/github/github/gh-cli";
import { GITHUB_SURFACE_CONTEXT } from "@/surfaces/github/runtime/context";

const log = createLogger("github-main");
const config = loadGitHubAppConfig();

await migrateDataDir(config.paths.dataDir, {
  logger: log,
});
await ensurePiRuntimeSetup(config.pi);
startEmbeddingIndexMaintenance({
  dataDir: config.paths.dataDir,
  skillsRoot: config.paths.skillsRoot,
  memoryRoot: resolve(config.paths.dataDir, "memory"),
  logger: createLogger("embedding-index"),
});

const bot = new GitHubBot({
  config,
  api: new GitHubApi(new GhCli({ command: config.github.ghCommand })),
  conversations: new ConversationStore(config.paths.dataDir),
  contextCompiler: new ContextCompiler(
    config.paths.configDirs,
    config.paths.dataDir,
    GITHUB_SURFACE_CONTEXT,
    config.environmentHint,
  ),
  provider: new PiCliClient(config.pi),
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason });
});

process.on("uncaughtException", (error) => {
  log.error("uncaught exception", { error: error.message });
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  bot.stop();
  process.exitCode = 130;
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exitCode = 143;
});

await bot.start();
