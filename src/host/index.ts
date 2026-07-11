import { resolve } from "node:path";

import { loadHostConfig } from "@/host/config";
import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { loadDreamingConfig } from "@/lib/memory/dreaming-config";
import { startMemoryDreaming } from "@/lib/memory/dreaming-service";
import { migrateDataDir } from "@/lib/migrations/data-dir";
import { PiCliClient } from "@/lib/provider/pi-cli-client";
import { ensurePiRuntimeSetup } from "@/lib/provider/pi-runtime-setup";
import { startEmbeddingIndexMaintenance } from "@/lib/retrieval/embedding-index-maintenance";
import { ApiBot } from "@/surfaces/api/bot/api-bot";
import { BrokerDesktopHands } from "@/surfaces/api/devices/desktop-hands";
import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";
import { API_SURFACE_CONTEXT } from "@/surfaces/api/runtime/context";
import { SandiBot } from "@/surfaces/discord/bot/sandi-bot";
import { DISCORD_SURFACE_CONTEXT } from "@/surfaces/discord/runtime/context";
import { GitHubBot } from "@/surfaces/github/bot/github-bot";
import { GitHubApi } from "@/surfaces/github/github/api";
import { GhCli } from "@/surfaces/github/github/gh-cli";
import { GITHUB_SURFACE_CONTEXT } from "@/surfaces/github/runtime/context";

// A bot exposes the same lifecycle regardless of surface. The host starts every
// enabled bot and stops them all on shutdown.
type Surface = {
  name: string;
  start(): Promise<void>;
  stop(): void;
};

const log = createLogger("host");
const config = loadHostConfig();
const { paths, pi } = config.api;
const environmentHint = config.api.environmentHint;

await migrateDataDir(paths.dataDir, { logger: log });
await ensurePiRuntimeSetup(pi);

// Shared singletons. One conversation store and one provider back every surface,
// so a human's conversations and account routing are the same brain wherever
// they reach Sandi. The device registry and tool broker are shared too: a
// desktop holds one link, and a turn from any surface can reach it.
const conversations = new ConversationStore(paths.dataDir);
const provider = new PiCliClient(pi);
const devices = new DeviceRegistry();
const broker = new ToolBroker(devices);
// Lets a turn from any surface reach the desktop belonging to its human, by
// identity, through the shared registry and broker.
const desktopHands = new BrokerDesktopHands(devices, broker);

const embeddingMaintenance = startEmbeddingIndexMaintenance({
  dataDir: paths.dataDir,
  skillsRoot: paths.skillsRoot,
  memoryRoot: resolve(paths.dataDir, "memory"),
  logger: createLogger("embedding-index"),
});

// Reviews recent conversations on its own schedule and writes memory without a
// turn having to spend attention on it: short-term episodic notes when a
// conversation goes idle, and a deeper overnight "dream" that consolidates those
// notes into durable memory.
const dreaming = startMemoryDreaming({
  dataDir: paths.dataDir,
  sessionDir: pi.sessionDir,
  provider,
  conversations,
  config: loadDreamingConfig(),
  logger: createLogger("dreaming"),
});

// The loopback broker must be listening before any bot accepts a turn that
// might lease a ticket against it.
await broker.start();

const surfaces: Surface[] = [];

// Every bot exposes the same start()/stop() lifecycle; this is the one part of
// the three registration blocks below that is genuinely identical, so it is
// the only part factored out. Their constructor calls stay inline because
// each surface wires up a different set of shared dependencies.
function registerSurface(
  name: string,
  bot: { start(): Promise<void>; stop(): void },
): void {
  surfaces.push({ name, start: () => bot.start(), stop: () => bot.stop() });
}

if (config.surfaces.api) {
  const apiBot = new ApiBot({
    config: config.api,
    conversations,
    contextCompiler: new ContextCompiler(
      paths.configDirs,
      paths.dataDir,
      API_SURFACE_CONTEXT,
      environmentHint,
    ),
    provider,
    devices,
    broker,
  });
  registerSurface("api", apiBot);
}

if (config.discord) {
  const discordBot = new SandiBot({
    config: config.discord,
    conversations,
    contextCompiler: new ContextCompiler(
      paths.configDirs,
      paths.dataDir,
      DISCORD_SURFACE_CONTEXT,
      environmentHint,
    ),
    provider,
    desktopHands,
  });
  registerSurface("discord", discordBot);
}

if (config.github) {
  const githubConfig = config.github;
  const githubBot = new GitHubBot({
    config: githubConfig,
    api: new GitHubApi(
      new GhCli({
        command: githubConfig.github.ghCommand,
        timeoutMs: githubConfig.github.ghTimeoutMs,
      }),
    ),
    conversations,
    contextCompiler: new ContextCompiler(
      paths.configDirs,
      paths.dataDir,
      GITHUB_SURFACE_CONTEXT,
      environmentHint,
    ),
    provider,
    desktopHands,
  });
  registerSurface("github", githubBot);
}

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

  for (const surface of surfaces) {
    try {
      surface.stop();
    } catch (error) {
      log.error("surface shutdown failed", {
        surface: surface.name,
        error: errorMessage(error),
      });
      process.exitCode = 1;
    }
  }

  // The shared resources outlive the individual surfaces, so close them once
  // here after every surface has stopped using them.
  try {
    devices.closeAll();
    broker.stop();
  } catch (error) {
    log.error("shared resource shutdown failed", {
      error: errorMessage(error),
    });
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

  try {
    dreaming.stop();
  } catch (error) {
    log.error("memory dreaming shutdown failed", {
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

log.info("starting sandi host", {
  surfaces: surfaces.map((surface) => surface.name),
});

// Start surfaces in sequence so a startup failure is attributed to one surface
// and the others are not left half-initialized behind a rejected Promise.all.
for (const surface of surfaces) {
  await surface.start();
}
