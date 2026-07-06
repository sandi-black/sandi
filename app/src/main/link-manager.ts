import type { LinkStatus } from "@shared/ipc-contract";

import {
  type DesktopCredentials,
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
  credentials(): DesktopCredentials | undefined;
};

export function createLinkManager(input: {
  // Tool paths in dispatched calls resolve against this directory.
  rootDir: string;
  events: LinkManagerEvents;
}): LinkManager {
  let controller: AbortController | undefined;
  let current: LinkStatus = { state: "connecting" };
  let creds: DesktopCredentials | undefined;

  const setStatus = (status: LinkStatus): void => {
    current = status;
    input.events.onStatus(status);
  };

  const runLoop = async (): Promise<void> => {
    creds = await loadDesktopCredentials(desktopConfigPath());
    if (!creds) {
      setStatus({ state: "unpaired" });
      return;
    }
    const credentials = creds;
    controller = new AbortController();
    setStatus({ state: "connecting" });
    await runDesktopClient({
      credentials,
      rootDir: input.rootDir,
      signal: controller.signal,
      onStatus: (message) => {
        if (message === "linked") {
          setStatus({ state: "linked" });
          return;
        }
        if (message.startsWith("link dropped")) {
          setStatus({ state: "dropped", message });
          return;
        }
        // Tool-result hiccups and other notices do not change the link state;
        // surface them on the current state's message instead.
        setStatus({ ...current, message });
      },
      onResponseChunk: (chunk) => input.events.onResponseChunk(chunk),
      onResponseAttachment: (attachment) =>
        input.events.onResponseAttachment(attachment),
    });
  };

  return {
    async start() {
      await runLoop();
    },
    async restart() {
      controller?.abort();
      // runLoop only settles when the app shuts down, so awaiting it here
      // would hang the caller (the pairing IPC response) until quit, even
      // though the reconnected link is already coming up. Relaunch in the
      // background and let its progress reach the UI through onStatus, the
      // same way start()'s loop does.
      void runLoop().catch((error: unknown) => {
        setStatus({ state: "dropped", message: "link restart failed" });
        console.error("link restart loop failed", error);
      });
    },
    stop() {
      controller?.abort();
    },
    status() {
      return current;
    },
    credentials() {
      return creds;
    },
  };
}
