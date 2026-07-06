import { isAbsolute, join } from "node:path";

import type { PetOutfit } from "@shared/animation-manifest";
import type {
  LinkStatus,
  ReplyAttachment,
  TurnSettledEvent,
} from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import type { PetBackground } from "@shared/pet-state-machine";
import {
  createResponseBuffer,
  type ResponseBuffer,
} from "@shared/response-buffer";
import { app, dialog, ipcMain, screen } from "electron";

import { installAssetProtocol, registerAssetScheme } from "./asset-protocol";
import { createAttachmentStaging } from "./attachment-staging";
import { createChatWindow } from "./chat-window";
import { registerAttachmentHandlers } from "./handlers/attachment-handlers";
import { registerFileHandlers } from "./handlers/file-handlers";
import { registerPairingHandlers } from "./handlers/pairing-handlers";
import { registerSessionHandlers } from "./handlers/session-handlers";
import { registerTurnHandlers } from "./handlers/turn-handlers";
import {
  createIdleFidgetScheduler,
  type IdleFidgetScheduler,
} from "./idle-fidget-scheduler";
import { ReplyAttachmentSchema } from "./ipc-schemas";
import { createLinkManager } from "./link-manager";
import { createPetWindow } from "./pet-window";
import { createSettingsStore } from "./settings-store";
import { createTranscriptStore } from "./transcript-store";
import { createTray, type TrayController } from "./tray";
import { createTurnManager } from "./turn-manager";
import { createTurnPipeline } from "./turn-pipeline";
import {
  createWanderScheduler,
  type WanderScheduler,
} from "./wander-scheduler";

// Composition root for the desktop app. Main owns everything stateful: the
// windows, tray, settings, device link, turn queue, and transcript store. The
// renderers are pure UI over the typed IPC bridges.

// Module scope on purpose: a garbage-collected Tray wrapper silently removes
// the icon from the notification area, and this reference is what pins it.
let tray: TrayController | undefined;

// A second launch should surface the existing pet, not spawn a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerAssetScheme();
  main().catch((error: unknown) => {
    // Startup failed outright (settings unreadable, a window refused to
    // build): surface it and exit rather than leaving a half-alive tray-less
    // process the human cannot see or quit.
    const message = error instanceof Error ? error.message : String(error);
    console.error("sandi-desktop failed to start", error);
    dialog.showErrorBox("Sandi could not start", message);
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  installAssetProtocol();

  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
  });

  const settings = createSettingsStore();
  // Re-assert the login item every launch so a moved executable (the portable
  // build) keeps the entry current. Packaged only: a dev run would register
  // the bare electron binary.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.get().autoLaunch });
  }
  const userData = app.getPath("userData");
  const store = await createTranscriptStore(join(userData, "transcripts"));
  const staging = createAttachmentStaging(join(userData, "staging"));

  // Assigned once the schedulers exist below; the pet window is created first
  // because they drive it. Both are idle-only ambient behaviors: wander walks
  // her across the display, fidget plays brief in-place idle animations.
  let wander: WanderScheduler | undefined;
  let fidget: IdleFidgetScheduler | undefined;

  const chat = createChatWindow({ isQuitting: () => quitting });
  const pet = createPetWindow({
    settings,
    onOpenChat: () => {
      wander?.interrupt();
      fidget?.interrupt();
      chat.toggleNear(pet.window.getBounds());
    },
    onDragStart: () => {
      wander?.interrupt();
      fidget?.interrupt();
    },
    // Keep the popover glued to her side as she is dragged; a no-op while the
    // chat is hidden (which is also every wander tick, since wander is gated
    // off whenever the chat is open).
    onMove: () => chat.follow(pet.window.getBounds()),
  });

  const sendToChat = (channel: string, payload: unknown): void => {
    if (!chat.window.isDestroyed()) {
      chat.window.webContents.send(channel, payload);
    }
  };

  // Per-turn accumulation of streamed deltas and reply attachments, so the
  // transcript records the reconciled text even though the renderer also
  // renders it live.
  const buffers = new Map<string, ResponseBuffer>();
  const replyAttachments = new Map<string, ReplyAttachment[]>();
  const bufferFor = (turnId: string): ResponseBuffer => {
    let buffer = buffers.get(turnId);
    if (!buffer) {
      buffer = createResponseBuffer(turnId);
      buffers.set(turnId, buffer);
    }
    return buffer;
  };

  // Pet display state, derived from real turn activity across every
  // conversation: waiting until deltas flow, running for answer text,
  // review while she thinks.
  const activeTurns = new Map<string, PetBackground>();
  const petBackground = (): PetBackground => {
    if (activeTurns.size === 0) return "idle";
    const phases = [...activeTurns.values()];
    if (phases.includes("running")) return "running";
    if (phases.includes("review")) return "review";
    return "waiting";
  };
  const refreshPetBackground = (): void => {
    pet.sendDisplayEvent({ type: "background", background: petBackground() });
  };
  const setTurnPhase = (turnId: string, phase: PetBackground): void => {
    if (!activeTurns.has(turnId)) return;
    if (activeTurns.get(turnId) === phase) return;
    activeTurns.set(turnId, phase);
    refreshPetBackground();
  };

  // Wander mode: idle strolls along the work area, driven from main because
  // main owns the window position. The gate composes every reason not to
  // walk; the scheduler itself rechecks it on each movement tick.
  const wanderScheduler = createWanderScheduler({
    getBounds: () => pet.window.getBounds(),
    setPosition: (x, y) => pet.moveTo(x, y),
    workAreaFor: (bounds) => screen.getDisplayMatching(bounds).workArea,
    canStroll: () =>
      activeTurns.size === 0 &&
      pet.window.isVisible() &&
      !pet.isDragging() &&
      !chat.window.isVisible() &&
      !(fidget?.isFidgeting() ?? false),
    sendDisplayEvent: (event) => pet.sendDisplayEvent(event),
    savePosition: (position) => settings.update({ petPosition: position }),
  });
  wander = wanderScheduler;
  wanderScheduler.setEnabled(settings.get().wander);

  // Idle fidgets share wander's idle gate and additionally hold off while she is
  // mid-stroll, so a walk and a blink never fight over the same moment. Unlike
  // wander, fidgets stay in place, so they run regardless of the wander setting.
  const fidgetScheduler = createIdleFidgetScheduler({
    canFidget: () =>
      activeTurns.size === 0 &&
      pet.window.isVisible() &&
      !pet.isDragging() &&
      !chat.window.isVisible() &&
      !wanderScheduler.isStrolling(),
    sendDisplayEvent: (event) => pet.sendDisplayEvent(event),
  });
  fidget = fidgetScheduler;
  fidgetScheduler.setEnabled(true);

  const link = createLinkManager({
    // Sandi's relative tool paths resolve against the home directory; her
    // reach is the human's own, so their home is the natural anchor.
    rootDir: app.getPath("home"),
    events: {
      onStatus: (status: LinkStatus) => {
        tray?.setLinkStatus(status);
        sendToChat(IPC.linkStatus, status);
      },
      onResponseChunk: (chunk) => {
        const accepted = bufferFor(chunk.turnId).accept(chunk);
        if (accepted) {
          setTurnPhase(
            chunk.turnId,
            accepted.channel === "thinking" ? "review" : "running",
          );
          sendToChat(IPC.turnDelta, {
            turnId: chunk.turnId,
            channel: accepted.channel,
            delta: accepted.delta,
          });
        }
      },
      onResponseAttachment: (attachment) => {
        // The tool's contract allows desktop-relative paths; everything
        // app-side (transcript, sandi-asset rendering, save-as) requires
        // absolute, so resolve here against the same root the link's tools
        // run under, then parse the resolved entry against the app's own
        // ReplyAttachment boundary before it reaches the transcript, the
        // renderer, or save-as.
        const parsed = ReplyAttachmentSchema.safeParse({
          path: isAbsolute(attachment.path)
            ? attachment.path
            : join(app.getPath("home"), attachment.path),
          ...(attachment.name !== undefined ? { name: attachment.name } : {}),
          ...(attachment.mimeType !== undefined
            ? { mimeType: attachment.mimeType }
            : {}),
        });
        if (!parsed.success) {
          console.error(
            "dropped a reply attachment that failed to parse",
            parsed.error,
          );
          return;
        }
        const entry: ReplyAttachment = {
          path: parsed.data.path,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.mimeType !== undefined
            ? { mimeType: parsed.data.mimeType }
            : {}),
        };
        const list = replyAttachments.get(attachment.turnId) ?? [];
        list.push(entry);
        replyAttachments.set(attachment.turnId, list);
        sendToChat(IPC.turnAttachment, {
          turnId: attachment.turnId,
          attachment: entry,
        });
      },
    },
  });

  const turnManager = createTurnManager({
    sendTurn: createTurnPipeline({ staging }),
    events: {
      onTurnStarted: ({ turnId }) => {
        wanderScheduler.interrupt();
        fidgetScheduler.interrupt();
        activeTurns.set(turnId, "waiting");
        refreshPetBackground();
      },
      onTurnSettled: (event) => {
        persistSettled(event).catch((error: unknown) => {
          // The turn itself settled; a failed transcript append loses history
          // but must not crash the app or block the settle event.
          console.error("failed to persist a settled turn", error);
        });
        activeTurns.delete(event.turnId);
        pet.sendDisplayEvent({
          type: "one-shot",
          row: event.ok ? "jumping" : "failed",
        });
        refreshPetBackground();
        sendToChat(IPC.turnSettled, event);
      },
      onQueueState: (state) => sendToChat(IPC.queueState, state),
    },
  });

  const persistSettled = async (event: TurnSettledEvent): Promise<void> => {
    const buffer = buffers.get(event.turnId);
    buffers.delete(event.turnId);
    const attachments = replyAttachments.get(event.turnId);
    replyAttachments.delete(event.turnId);
    if (event.ok) {
      const finalText = event.text ?? "";
      buffer?.settle(finalText);
      const thinking = buffer?.snapshot().thinking ?? "";
      await store.appendEntry(event.conversationId, {
        type: "assistant",
        turnId: event.turnId,
        ts: new Date().toISOString(),
        text: finalText,
        ...(thinking.length > 0 ? { thinking } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    } else {
      await store.appendEntry(event.conversationId, {
        type: "error",
        turnId: event.turnId,
        ts: new Date().toISOString(),
        text: event.error ?? "turn failed",
      });
    }
  };

  registerSessionHandlers({
    store,
    onSessionsChanged: () => sendToChat(IPC.sessionsChanged, undefined),
  });
  registerTurnHandlers({ turnManager, store, staging });
  registerAttachmentHandlers({ staging });
  registerFileHandlers();
  registerPairingHandlers({
    onPaired: async () => {
      await link.restart();
    },
  });
  ipcMain.handle(IPC.linkStatusGet, () => link.status());

  tray = createTray({
    settings,
    onToggleSandi: () => pet.toggleVisibility(),
    onOpenChat: () => {
      wanderScheduler.interrupt();
      fidgetScheduler.interrupt();
      chat.openNear(pet.window.getBounds());
    },
    onOutfitChange: (outfit: PetOutfit) => pet.sendOutfit(outfit),
    onWanderChange: (enabled: boolean) => wanderScheduler.setEnabled(enabled),
  });

  app.on("second-instance", () => {
    pet.window.show();
  });

  // The pet greets on launch once her renderer is ready.
  pet.window.webContents.once("did-finish-load", () => {
    pet.sendDisplayEvent({ type: "one-shot", row: "waving" });
  });

  // Tray-owned lifecycle: the app stays alive with every window hidden, so
  // the default close-all-windows quit must not fire.
  app.on("window-all-closed", () => {
    // Intentionally empty: quitting is the tray's job.
  });

  // The device link runs for the app's whole life, reconnecting on its own;
  // this promise only resolves when the app is shutting down. A rejection
  // means the loop itself died (not a dropped connection, which it retries
  // internally), so reflect that in the status instead of leaving "linked" up.
  link.start().catch((error: unknown) => {
    console.error("device link loop failed", error);
    tray?.setLinkStatus({ state: "dropped", message: "link loop failed" });
    sendToChat(IPC.linkStatus, {
      state: "dropped",
      message: "link loop failed; restart the app or re-pair",
    });
  });
  app.on("before-quit", () => {
    wanderScheduler.dispose();
    fidgetScheduler.dispose();
    link.stop();
  });
}
