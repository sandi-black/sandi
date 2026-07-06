import { join } from "node:path";

import { IPC } from "@shared/ipc-contract";
import { BrowserWindow, ipcMain, screen } from "electron";

import { parseRendererDevServerUrl } from "./renderer-url";
import { computeAnchoredPosition } from "./window-anchor";

// The popover chat window. Created hidden at startup and shown/hidden for the
// rest of the app's life: closing hides, and only the tray's Quit destroys.
// It deliberately has no blur handler; unlike a standard popover it stays up
// when clicked away, and only an explicit close dismisses it.

const CHAT_WIDTH = 400;
const CHAT_HEIGHT = 600;

export type ChatWindow = {
  window: BrowserWindow;
  openNear(petBounds: Electron.Rectangle): void;
  toggleNear(petBounds: Electron.Rectangle): void;
  hide(): void;
};

export function createChatWindow(input: { isQuitting(): boolean }): ChatWindow {
  const win = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/chat.cjs"),
      contextIsolation: true,
      // Unsandboxed for the same preload-chunk reason as the pet window.
      sandbox: false,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");

  // An OS-level close (Alt+F4) hides like the in-app close button; the window
  // is only allowed to die when the app is quitting for real.
  win.on("close", (event) => {
    if (input.isQuitting()) return;
    event.preventDefault();
    win.hide();
  });

  ipcMain.on(IPC.chatClose, (event) => {
    if (event.sender !== win.webContents) return;
    win.hide();
  });

  loadRenderer(win).catch((error: unknown) => {
    console.error("chat renderer failed to load", error);
  });

  return {
    window: win,
    openNear(petBounds) {
      position(win, petBounds);
      win.show();
      win.focus();
    },
    toggleNear(petBounds) {
      if (win.isVisible()) {
        win.hide();
        return;
      }
      position(win, petBounds);
      win.show();
      win.focus();
    },
    hide() {
      win.hide();
    },
  };
}

function position(win: BrowserWindow, petBounds: Electron.Rectangle): void {
  const display = screen.getDisplayNearestPoint({
    x: petBounds.x,
    y: petBounds.y,
  });
  const point = computeAnchoredPosition(
    petBounds,
    { width: CHAT_WIDTH, height: CHAT_HEIGHT },
    display.workArea,
  );
  win.setPosition(point.x, point.y);
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = parseRendererDevServerUrl(
    process.env["ELECTRON_RENDERER_URL"],
  );
  if (devUrl) {
    await win.loadURL(`${devUrl}/chat/index.html`);
    return;
  }
  await win.loadFile(join(import.meta.dirname, "../renderer/chat/index.html"));
}
