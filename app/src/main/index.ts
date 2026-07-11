import { isAbsolute, join } from "node:path";

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
import { app, dialog, ipcMain, screen, shell } from "electron";

import { installAssetProtocol, registerAssetScheme } from "./asset-protocol";
import { createAttachmentStaging } from "./attachment-staging";
import { createAutoTitler } from "./auto-titler";
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
import { requireIpcOwner } from "./ipc-owner";
import { ReplyAttachmentSchema } from "./ipc-schemas";
import { createLinkManager } from "./link-manager";
import { createPetWindow } from "./pet-window";
import { createSettingsStore } from "./settings-store";
import { createTranscriptStore } from "./transcript-store";
import { createTray, type TrayController } from "./tray";
import { createTurnManager } from "./turn-manager";
import { createTurnPipeline } from "./turn-pipeline";
import {
  createUpdater,
  detectUpdateFlavor,
  RELEASES_URL,
  type UpdaterController,
} from "./updater";
import {
  createWanderScheduler,
  type WanderScheduler,
} from "./wander-scheduler";
import {
  desktopConfigPath,
  loadDesktopCredentials,
} from "@sandi-server/surfaces/api/client/credentials";
import { generateTitle } from "@sandi-server/surfaces/api/client/titles";

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

  const chat = createChatWindow({ isQuitting: () => quitting, settings });
  // The same greeting spell she casts on launch, fired when the chat opens.
  const greetOnChatOpen = (): void => {
    if (chat.window.isVisible()) return;
    pet.sendDisplayEvent({ type: "one-shot", row: "casting" });
  };
  const pet = createPetWindow({
    settings,
    onOpenChat: () => openChat(chat.toggleNear),
    onDragStart: () => {
      wander?.interrupt();
      fidget?.interrupt();
    },
    // Keep the popover glued to her side as she is dragged; a no-op while the
    // chat is hidden (which is also every wander tick, since wander is gated
    // off whenever the chat is open).
    onMove: () => chat.follow(pet.window.getBounds()),
  });

  // Shared by the pet's own open gesture and the tray's: interrupt both
  // ambient schedulers, clear the reply-alert marker, greet if this is the
  // first open since launch, then hand off to whichever placement the caller
  // wants (toggle for the pet, always-open for the tray).
  const openChat = (show: (bounds: Electron.Rectangle) => void): void => {
    wander?.interrupt();
    fidget?.interrupt();
    pet.sendDisplayEvent({ type: "reply-alert", visible: false });
    greetOnChatOpen();
    show(pet.window.getBounds());
  };

  const sendToChat = (channel: string, payload: unknown): void => {
    if (!chat.window.isDestroyed()) {
      chat.window.webContents.send(channel, payload);
    }
  };

  // Per-turn accumulation of streamed deltas and reply attachments, so the
  // transcript records the reconciled text even though the renderer also
  // renders it live.
  const turnConversations = new Map<string, string>();
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

  // Both ambient schedulers refuse to run unless the pet is fully idle: no
  // turn active, visible, not being dragged, and the chat popover closed.
  // Each then adds the one condition that keeps it from fighting the other.
  const baseIdleGate = (): boolean =>
    activeTurns.size === 0 &&
    pet.window.isVisible() &&
    !pet.isDragging() &&
    !chat.window.isVisible();

  // Wander mode: idle strolls along the work area, driven from main because
  // main owns the window position. The gate composes every reason not to
  // walk; the scheduler itself rechecks it on each movement tick.
  const wanderScheduler = createWanderScheduler({
    getBounds: () => pet.window.getBounds(),
    setPosition: (x, y) => pet.moveTo(x, y),
    workAreaFor: (bounds) => screen.getDisplayMatching(bounds).workArea,
    canStroll: () => baseIdleGate() && !(fidget?.isFidgeting() ?? false),
    sendDisplayEvent: (event) => pet.sendDisplayEvent(event),
    savePosition: (position) => settings.update({ petPosition: position }),
  });
  wander = wanderScheduler;
  wanderScheduler.setEnabled(settings.get().wander);

  // Idle fidgets share wander's idle gate and additionally hold off while she is
  // mid-stroll, so a walk and a blink never fight over the same moment. Unlike
  // wander, fidgets stay in place, so they run regardless of the wander setting.
  const fidgetScheduler = createIdleFidgetScheduler({
    canFidget: () => baseIdleGate() && !wanderScheduler.isStrolling(),
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
        const conversationId = turnConversations.get(chunk.turnId);
        // A late frame from a settled or unknown turn must not create a new
        // buffer or be attributed to whichever conversation happens to be
        // visible in the renderer.
        if (conversationId === undefined) return;
        const accepted = bufferFor(chunk.turnId).accept(chunk);
        if (accepted) {
          setTurnPhase(
            chunk.turnId,
            accepted.channel === "thinking" ? "review" : "running",
          );
          sendToChat(IPC.turnDelta, {
            turnId: chunk.turnId,
            conversationId,
            channel: accepted.channel,
            delta: accepted.delta,
          });
        }
      },
      onResponseAttachment: (attachment) => {
        const conversationId = turnConversations.get(attachment.turnId);
        if (conversationId === undefined) return;
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
          conversationId,
          attachment: entry,
        });
      },
    },
  });

  const turnManager = createTurnManager({
    sendTurn: createTurnPipeline({ staging }),
    events: {
      onTurnStarted: ({ conversationId, turnId }) => {
        wanderScheduler.interrupt();
        fidgetScheduler.interrupt();
        turnConversations.set(turnId, conversationId);
        activeTurns.set(turnId, "waiting");
        refreshPetBackground();
      },
      onTurnSettled: (event) => {
        turnConversations.delete(event.turnId);
        // The renderer reloads successful turns from disk to pick up thinking
        // and attachments. Publish settlement only after that append finishes
        // so the reload cannot race ahead of the authoritative transcript.
        void persistSettled(event)
          .catch((error: unknown) => {
            // The turn itself settled; a failed transcript append loses
            // history but must not crash the app or hide the live outcome.
            console.error("failed to persist a settled turn", error);
          })
          .then(() => sendToChat(IPC.turnSettled, event))
          .catch((error: unknown) => {
            console.error("failed to publish a settled turn", error);
          });
        activeTurns.delete(event.turnId);
        pet.sendDisplayEvent({
          type: "one-shot",
          row: event.ok ? "celebrating" : "startled",
        });
        // Failures earn the marker as much as replies do: either way there is
        // an outcome waiting in a chat the user cannot currently see.
        if (!chat.window.isVisible()) {
          pet.sendDisplayEvent({ type: "reply-alert", visible: true });
        }
        refreshPetBackground();
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

  const notifySessionsChanged = (): void =>
    sendToChat(IPC.sessionsChanged, undefined);

  // Names a fresh conversation from its opening message by asking the server to
  // title it (a one-off model turn, like Discord's thread naming), then renames
  // the local session. Credentials load fresh each time, so a re-pair takes
  // effect without a restart, exactly as the turn pipeline does.
  const autoTitler = createAutoTitler({
    store,
    requestTitle: async ({ conversationId, message }) => {
      const credentials = await loadDesktopCredentials(desktopConfigPath());
      if (!credentials) return undefined;
      const outcome = await generateTitle({
        url: credentials.url,
        token: credentials.token,
        conversationId,
        message,
      });
      return outcome.ok ? outcome.title : undefined;
    },
    onTitled: notifySessionsChanged,
  });

  const ipcOwner = chat.window.webContents;
  registerSessionHandlers({
    owner: ipcOwner,
    store,
    onSessionsChanged: notifySessionsChanged,
  });
  registerTurnHandlers({
    owner: ipcOwner,
    turnManager,
    store,
    staging,
    autoTitler,
  });
  registerAttachmentHandlers({ owner: ipcOwner, staging });
  registerFileHandlers({ owner: ipcOwner });
  registerPairingHandlers({
    owner: ipcOwner,
    onPaired: async () => {
      await link.restart();
    },
  });
  ipcMain.handle(IPC.linkStatusGet, (event) => {
    requireIpcOwner(event, ipcOwner);
    return link.status();
  });

  // Self-update: the installed app stages new releases in the background and
  // installs on quit (or from the tray); the portable exe can only point at
  // the download page; a dev run gets no updater and no tray section.
  const updateFlavor = detectUpdateFlavor();
  const updater: UpdaterController | undefined =
    updateFlavor === "dev"
      ? undefined
      : createUpdater({
          flavor: updateFlavor,
          autoCheck: settings.get().autoUpdate,
          // The optional chain covers the first checks racing tray creation
          // just below; every later state change lands on the live menu.
          onState: (state) => tray?.setUpdateState(state),
        });

  tray = createTray({
    settings,
    onToggleSandi: () => pet.toggleVisibility(),
    onOpenChat: () => openChat(chat.openNear),
    onWanderChange: (enabled: boolean) => wanderScheduler.setEnabled(enabled),
    ...(updater
      ? {
          updates: {
            initialState: updater.state(),
            onCheck: () => updater.checkNow(),
            onInstall: () => updater.quitAndInstall(),
            onDownload: () => {
              shell.openExternal(RELEASES_URL).catch((error: unknown) => {
                console.error("failed to open the releases page", error);
              });
            },
            onAutoUpdateChange: (enabled) => updater.setAutoCheck(enabled),
          },
        }
      : {}),
  });

  app.on("second-instance", () => {
    pet.window.show();
  });

  // The pet greets on launch once her renderer is ready: she casts a little
  // spell as she materializes.
  pet.window.webContents.once("did-finish-load", () => {
    pet.sendDisplayEvent({ type: "one-shot", row: "casting" });
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
  // The transcript index write is debounced (see transcript-store.ts), so a
  // quit landing inside that window must not drop it: defer the quit exactly
  // once to flush it, then let the second before-quit through untouched. The
  // flush races a timeout so a wedged disk write (network drive, AV lock)
  // degrades to the old fire-and-forget behavior instead of an unquittable
  // app.
  let indexFlushed = false;
  app.on("before-quit", (event) => {
    wanderScheduler.dispose();
    fidgetScheduler.dispose();
    updater?.dispose();
    link.stop();
    if (indexFlushed) return;
    event.preventDefault();
    const flushTimeout = new Promise<void>((resolveTimeout) => {
      setTimeout(() => {
        console.error("transcript index flush timed out on quit");
        resolveTimeout();
      }, 5_000).unref();
    });
    Promise.race([store.flushIndex(), flushTimeout])
      .catch((error: unknown) => {
        console.error("failed to flush the transcript index on quit", error);
      })
      .finally(() => {
        indexFlushed = true;
        app.quit();
      });
  });
}
