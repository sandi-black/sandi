import type { BrowserWindow } from "electron";
import { shell } from "electron";

import { parseExternalHttpUrl } from "./external-url";

export function lockWindowToRenderer(win: BrowserWindow): void {
  const openExternal = (raw: string): void => {
    const url = parseExternalHttpUrl(raw);
    if (!url) return;
    shell.openExternal(url).catch((error: unknown) => {
      console.error("failed to open external link", error);
    });
  };

  // BrowserWindow.loadURL/loadFile are application-initiated and do not emit
  // will-frame-navigate. Every document-initiated navigation is therefore an
  // attempt to leave the trusted renderer and must be kept out of-window.
  win.webContents.on("will-frame-navigate", (event) => {
    event.preventDefault();
    if (event.isMainFrame) openExternal(event.url);
  });
  win.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
}
