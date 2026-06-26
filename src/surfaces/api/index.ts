import { resolve } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { createLogger } from "@/lib/logging";
import { migrateDataDir } from "@/lib/migrations/data-dir";
import { PiCliClient } from "@/lib/provider/pi-cli-client";
import { ensurePiRuntimeSetup } from "@/lib/provider/pi-runtime-setup";
import { startEmbeddingIndexMaintenance } from "@/lib/retrieval/embedding-index-maintenance";
import { ApiBot } from "@/surfaces/api/bot/api-bot";
import { loadApiAppConfig } from "@/surfaces/api/config";
import { API_SURFACE_CONTEXT } from "@/surfaces/api/runtime/context";

const log = createLogger("api-main");
const config = loadApiAppConfig();

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

const bot = new ApiBot({
  config,
  conversations: new ConversationStore(config.paths.dataDir),
  contextCompiler: new ContextCompiler(
    config.paths.configDirs,
    config.paths.dataDir,
    API_SURFACE_CONTEXT,
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

let shutdownStarted = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info("shutdown signal received", { signal });

  try {
    bot.stop();
  } catch (error) {
    log.error("API bot shutdown failed", { error: errorMessage(error) });
    process.exitCode = 1;
  }

  try {
    embeddingMaintenance.stop();
  } catch (error) {
    log.error("embedding maintenance shutdown failed", {
      error: errorMessage(error),
    });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

await bot.start();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
