import type {
  LinkStatus,
  QueueState,
  SandiChatBridge,
  TurnAttachmentEvent,
  TurnDeltaEvent,
  TurnSettledEvent,
} from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { contextBridge, ipcRenderer, webUtils } from "electron";

// The chat window's bridge: sessions, turns, attachments, pairing, and the
// push-event subscriptions. All real state lives main-side; this file only
// shuttles typed payloads across the isolation boundary.

function subscribe<Payload>(
  channel: string,
): (listener: (payload: Payload) => void) => () => void {
  return (listener) => {
    const handler = (_event: unknown, payload: Payload): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: SandiChatBridge = {
  listSessions: () => ipcRenderer.invoke(IPC.sessionList),
  createSession: (title) => ipcRenderer.invoke(IPC.sessionCreate, title),
  selectSession: (conversationId) =>
    ipcRenderer.invoke(IPC.sessionSelect, conversationId),
  renameSession: (conversationId, title) =>
    ipcRenderer.invoke(IPC.sessionRename, conversationId, title),
  deleteSession: (conversationId) =>
    ipcRenderer.invoke(IPC.sessionDelete, conversationId),

  submitTurn: (input) => ipcRenderer.invoke(IPC.turnSubmit, input),
  stopTurn: (turnId) => ipcRenderer.invoke(IPC.turnStop, turnId),
  cancelQueued: (turnId) => ipcRenderer.invoke(IPC.turnCancelQueued, turnId),

  pickAttachments: () => ipcRenderer.invoke(IPC.attachmentPick),
  // The path never touches the renderer's own code: sandbox-era drag-drop
  // resolves it here via webUtils, then main stages it like any picked file.
  stageDroppedFile: (file) =>
    ipcRenderer.invoke(IPC.attachmentStageDrop, webUtils.getPathForFile(file)),
  stagePastedImage: (dataUrl) =>
    ipcRenderer.invoke(IPC.attachmentStagePaste, dataUrl),
  unstageAttachment: (id) => ipcRenderer.invoke(IPC.attachmentUnstage, id),
  saveAttachmentAs: (attachment) =>
    ipcRenderer.invoke(IPC.attachmentSaveAs, attachment),

  pair: (code) => ipcRenderer.invoke(IPC.pairRedeem, code),
  getLinkStatus: () => ipcRenderer.invoke(IPC.linkStatusGet),
  closeWindow: () => ipcRenderer.send(IPC.chatClose),
  beginResize: (edge) => ipcRenderer.send(IPC.chatResizeStart, edge),
  resizeMove: () => ipcRenderer.send(IPC.chatResizeMove),
  endResize: () => ipcRenderer.send(IPC.chatResizeEnd),

  onLinkStatus: subscribe<LinkStatus>(IPC.linkStatus),
  onTurnDelta: subscribe<TurnDeltaEvent>(IPC.turnDelta),
  onTurnAttachment: subscribe<TurnAttachmentEvent>(IPC.turnAttachment),
  onTurnSettled: subscribe<TurnSettledEvent>(IPC.turnSettled),
  onQueueState: subscribe<QueueState>(IPC.queueState),
  onSessionsChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(IPC.sessionsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.sessionsChanged, handler);
  },
};

contextBridge.exposeInMainWorld("sandiChat", bridge);
