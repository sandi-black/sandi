import type { IpcMainInvokeEvent, WebContents } from "electron";

// IPC registration is process-global, so channel names alone do not prove the
// caller is one of Sandi's trusted renderers. Every privileged request must be
// bound to the WebContents that owns its preload bridge.
export function requireIpcOwner(
  event: IpcMainInvokeEvent,
  owner: WebContents,
): void {
  if (event.sender !== owner) {
    throw new Error("unauthorized IPC sender");
  }
}
