import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { createLogger } from "@/lib/logging";
import { migrateDataDir } from "@/lib/migrations/data-dir";
import { PiCliClient } from "@/lib/provider/pi-cli-client";
import { ensurePiRuntimeSetup } from "@/lib/provider/pi-runtime-setup";
import { SandiBot } from "@/surfaces/discord/bot/sandi-bot";
import { loadDiscordAppConfig } from "@/surfaces/discord/config";
import { DISCORD_SURFACE_CONTEXT } from "@/surfaces/discord/runtime/context";

const log = createLogger("main");
const config = loadDiscordAppConfig();
await migrateDataDir(config.paths.dataDir, {
  logger: log,
});
await ensurePiRuntimeSetup(config.pi);

const bot = new SandiBot({
  config,
  conversations: new ConversationStore(config.paths.dataDir),
  contextCompiler: new ContextCompiler(
    config.paths.configDirs,
    config.paths.dataDir,
    DISCORD_SURFACE_CONTEXT,
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

await bot.start();
