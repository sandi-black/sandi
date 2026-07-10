import { access, rm } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isMissingFileError } from "../fs-errors";

const STOP_FILE_ENV = "SANDI_PI_STOP_FILE";
const POLL_INTERVAL_MS = 250;

export default function stopSentinelExtension(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let aborting = false;

  const stopPolling = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    aborting = false;
  };

  pi.on("agent_start", (_event, ctx) => {
    stopPolling();
    const check = async (): Promise<void> => {
      if (aborting) return;
      const stopFile = process.env[STOP_FILE_ENV]?.trim();
      if (!stopFile) return;
      if (!(await fileExists(stopFile))) return;
      aborting = true;
      await rm(stopFile, { force: true });
      await ctx.abort();
    };

    void check();
    timer = setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);
    ctx.signal?.addEventListener("abort", stopPolling, { once: true });
  });

  pi.on("agent_end", () => {
    stopPolling();
  });

  pi.on("session_shutdown", () => {
    stopPolling();
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}
