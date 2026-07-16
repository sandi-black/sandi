import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

// IPC registration is process-global, so channel names alone do not prove the
// caller is one of Sandi's trusted renderers. Every privileged request must be
// bound to the WebContents that owns its preload bridge.
export function requireIpcOwner(event: IpcEvent, owner: WebContents): void {
  if (!isIpcOwner(event, owner)) {
    throw new Error("unauthorized IPC sender");
  }
}

export function isIpcOwner(event: IpcEvent, owner: WebContents): boolean {
  const senderFrame = event.senderFrame;
  const ownerFrame = owner.mainFrame;
  return (
    event.sender === owner &&
    senderFrame !== null &&
    senderFrame.processId === ownerFrame.processId &&
    senderFrame.routingId === ownerFrame.routingId
  );
}
