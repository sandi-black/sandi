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
import { SandiBot } from "@/surfaces/discord/bot/sandi-bot";
import { loadDiscordAppConfig } from "@/surfaces/discord/config";
import { DISCORD_SURFACE_CONTEXT } from "@/surfaces/discord/runtime/context";

const log = createLogger("main");
const config = loadDiscordAppConfig();
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
const bot = new SandiBot({
  config,
  conversations: new ConversationStore(config.paths.dataDir),
  contextCompiler: new ContextCompiler(
    config.paths.configDirs,
    config.paths.dataDir,
    DISCORD_SURFACE_CONTEXT,
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

  try {
    bot.stop();
  } catch (error) {
    log.error("Discord bot shutdown failed", { error: errorMessage(error) });
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

function fatalShutdown(kind: string, error: unknown): void {
  log.error(kind, { error: errorMessage(error) });
  process.exitCode = 1;
  shutdown(kind);
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
