import type { LinkStatus } from "@shared/ipc-contract";

import {
  desktopConfigPath,
  loadDesktopCredentials,
} from "@sandi-server/surfaces/api/client/credentials";
import { runDesktopClient } from "@sandi-server/surfaces/api/client/desktop-client";
import type {
  ResponseAttachment,
  ResponseChunk,
} from "@sandi-server/surfaces/api/devices/protocol";

// Owns the app's one device link: the SSE connection that executes sandi's
// hands-local tool calls on this machine and carries her streamed replies.
// Wraps the reference client's runDesktopClient loop with status derivation,
// credential (re)loading, and restart-on-pair.

export type LinkManagerEvents = {
  onStatus(status: LinkStatus): void;
  onResponseChunk(chunk: ResponseChunk): void;
  onResponseAttachment(attachment: ResponseAttachment): void;
};

export type LinkManager = {
  start(): Promise<void>;
  // Reloads credentials from disk and reconnects; called after pairing, and on
  // auth failures so a re-pair in the CLI revives a running app.
  restart(): Promise<void>;
  stop(): void;
  status(): LinkStatus;
};

export function createLinkManager(input: {
  // Tool paths in dispatched calls resolve against this directory.
  rootDir: string;
  events: LinkManagerEvents;
  loadCredentials?: () => ReturnType<typeof loadDesktopCredentials>;
  runClient?: typeof runDesktopClient;
}): LinkManager {
  const loadCredentials =
    input.loadCredentials ??
    (() => loadDesktopCredentials(desktopConfigPath()));
  const runClient = input.runClient ?? runDesktopClient;
  let generation = 0;
  let active:
    | { generation: number; controller: AbortController; run: Promise<void> }
    | undefined;
  let current: LinkStatus = { state: "connecting" };

  const setStatus = (runGeneration: number, status: LinkStatus): void => {
    if (runGeneration !== generation) return;
    current = status;
    input.events.onStatus(status);
  };

  const runLoop = async (
    runGeneration: number,
    controller: AbortController,
  ): Promise<void> => {
    const credentials = await loadCredentials();
    if (runGeneration !== generation) return;
    if (!credentials) {
      setStatus(runGeneration, { state: "unpaired" });
      return;
    }
    setStatus(runGeneration, { state: "connecting" });
    await runClient({
      credentials,
      rootDir: input.rootDir,
      signal: controller.signal,
      onStatus: (message) => {
        if (runGeneration !== generation) return;
        if (message === "linked") {
          setStatus(runGeneration, { state: "linked" });
          return;
        }
        if (message.startsWith("link dropped")) {
          setStatus(runGeneration, { state: "dropped", message });
          return;
        }
        // Tool-result hiccups and other notices do not change the link state;
        // surface them on the current state's message instead.
        setStatus(runGeneration, { ...current, message });
      },
      onResponseChunk: (chunk) => {
        if (runGeneration === generation) input.events.onResponseChunk(chunk);
      },
      onResponseAttachment: (attachment) => {
        if (runGeneration === generation) {
          input.events.onResponseAttachment(attachment);
        }
      },
    });
  };

  const launch = (runGeneration: number): Promise<void> => {
    const controller = new AbortController();
    const run = runLoop(runGeneration, controller).finally(() => {
      if (active?.generation === runGeneration) active = undefined;
    });
    active = { generation: runGeneration, controller, run };
    return run;
  };

  return {
    async start() {
      const runGeneration = ++generation;
      const previous = active;
      previous?.controller.abort();
      await previous?.run.catch(() => undefined);
      if (runGeneration !== generation) return;
      await launch(runGeneration);
    },
    async restart() {
      const runGeneration = ++generation;
      const previous = active;
      previous?.controller.abort();
      // Serializing replacement closes the race where two rapid pairings both
      // started a link and only the last controller remained stoppable.
      await previous?.run.catch(() => undefined);
      if (runGeneration !== generation) return;
      void launch(runGeneration).catch((error: unknown) => {
        setStatus(runGeneration, {
          state: "dropped",
          message: "link restart failed",
        });
        console.error("link restart loop failed", error);
      });
    },
    stop() {
      generation++;
      active?.controller.abort();
    },
    status() {
      return current;
    },
  };
}
