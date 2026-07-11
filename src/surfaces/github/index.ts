import { resolve } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { migrateDataDir } from "@/lib/migrations/data-dir";
import { CapacityControlledProvider } from "@/lib/provider/capacity-controller";
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
const embeddingMaintenance = startEmbeddingIndexMaintenance({
  dataDir: config.paths.dataDir,
  skillsRoot: config.paths.skillsRoot,
  memoryRoot: resolve(config.paths.dataDir, "memory"),
  logger: createLogger("embedding-index"),
});

const provider = new CapacityControlledProvider(
  new PiCliClient(config.pi),
  config.providerCapacity,
);
const bot = new GitHubBot({
  config,
  api: new GitHubApi(
    new GhCli({
      command: config.github.ghCommand,
      timeoutMs: config.github.ghTimeoutMs,
    }),
  ),
  conversations: new ConversationStore(config.paths.dataDir),
  contextCompiler: new ContextCompiler(
    config.paths.configDirs,
    config.paths.dataDir,
    GITHUB_SURFACE_CONTEXT,
    config.environmentHint,
  ),
  provider,
});

process.once("unhandledRejection", (reason) => {
  fatalShutdown("unhandled rejection", reason);
});

process.once("uncaughtException", (error) => {
  fatalShutdown("uncaught exception", error);
});

let shutdownStarted = false;

function shutdown(signal: string): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info("shutdown signal received", { signal });
  void provider.shutdown();

  bot.stop();
  embeddingMaintenance.stop();
}

function fatalShutdown(kind: string, error: unknown): void {
  log.error(kind, { error: errorMessage(error) });
  process.exitCode = 1;
  try {
    shutdown(kind);
  } catch (shutdownError) {
    log.error("GitHub bot fatal shutdown failed", {
      error: errorMessage(shutdownError),
    });
  }
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

await bot.start();
