import { join } from "node:path";

import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  type PetOutfit,
} from "@shared/animation-manifest";
import type { PetDisplayEvent, SandiPetBridge } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { BrowserWindow, ipcMain, screen } from "electron";

import { CursorPointSchema, IgnoreMouseSchema } from "./ipc-schemas";
import type { SettingsStore } from "./settings-store";
import { clampIntoWorkArea } from "./window-anchor";

// The pet's window is exactly one sprite frame: transparent, chromeless, above
// everything, absent from the taskbar. Dragging is manual (main moves the
// window from the OS cursor position) because -webkit-app-region: drag on a
// transparent window has long-standing DWM hit-test bugs on Windows, and
// because reading the cursor main-side sidesteps DPI coordinate mismatches
// between renderer and screen space entirely.

export type PetWindow = {
  window: BrowserWindow;
  sendDisplayEvent(event: PetDisplayEvent): void;
  sendOutfit(outfit: PetOutfit): void;
  toggleVisibility(): void;
  // True while the human is dragging her; wander yields to the hand.
  isDragging(): boolean;
};

export function createPetWindow(input: {
  settings: SettingsStore;
  onOpenChat(): void;
  onDragStart?(): void;
}): PetWindow {
  const { settings, onOpenChat } = input;

  const win = new BrowserWindow({
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // The pet never takes keyboard focus, so clicking her does not steal it
    // from whatever the human is working in.
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/pet.cjs"),
      contextIsolation: true,
      // Unsandboxed so the bundled preloads may require their shared chunks;
      // isolation still holds (no nodeIntegration, bridge-only exposure), and
      // restraining sandi is a non-goal in this app by design.
      sandbox: false,
      nodeIntegration: false,
      // The sprite loop must keep animating while unfocused; that is the
      // pet's entire job.
      backgroundThrottling: false,
    },
  });
  // Above normal always-on-top windows, so another app's own AOT window does
  // not cover her.
  win.setAlwaysOnTop(true, "screen-saver");

  restorePosition(win, settings);

  // Manual drag: the renderer reports pointer grip and release; every move
  // tick reads the true cursor from the screen module and repositions the
  // window by the grip offset.
  let dragOffset: { x: number; y: number } | undefined;
  ipcMain.on(IPC.petDragStart, (event) => {
    if (event.sender !== win.webContents) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    dragOffset = { x: (x ?? 0) - cursor.x, y: (y ?? 0) - cursor.y };
    input.onDragStart?.();
  });
  ipcMain.on(IPC.petDragMove, (event, payload) => {
    if (event.sender !== win.webContents) return;
    // The payload cursor is advisory; the screen module is the authority.
    CursorPointSchema.optional().safeParse(payload);
    if (!dragOffset) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(cursor.x + dragOffset.x, cursor.y + dragOffset.y, false);
  });
  ipcMain.on(IPC.petDragEnd, (event) => {
    if (event.sender !== win.webContents) return;
    if (!dragOffset) return;
    dragOffset = undefined;
    const [x, y] = win.getPosition();
    settings.update({ petPosition: { x: x ?? 0, y: y ?? 0 } });
  });

  ipcMain.on(IPC.petOpenChat, (event) => {
    if (event.sender !== win.webContents) return;
    onOpenChat();
  });

  ipcMain.on(IPC.petSetIgnoreMouse, (event, payload) => {
    if (event.sender !== win.webContents) return;
    const parsed = IgnoreMouseSchema.safeParse(payload);
    if (!parsed.success) return;
    // forward: true keeps delivering pointer-move to the renderer while
    // ignoring clicks, so alpha sampling can re-enable interaction the moment
    // the cursor returns to a visible pixel.
    win.setIgnoreMouseEvents(parsed.data, { forward: true });
  });

  ipcMain.handle(IPC.petGetOutfit, () => settings.get().outfit);

  win.once("ready-to-show", () => win.show());
  void loadRenderer(win);

  return {
    window: win,
    sendDisplayEvent(event) {
      win.webContents.send(IPC.petDisplayEvent, event);
    },
    sendOutfit(outfit) {
      win.webContents.send(IPC.petOutfitChanged, outfit);
    },
    toggleVisibility() {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
      }
    },
    isDragging() {
      return dragOffset !== undefined;
    },
  };
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    await win.loadURL(`${devUrl}/pet/index.html`);
    return;
  }
  await win.loadFile(join(import.meta.dirname, "../renderer/pet/index.html"));
}

function restorePosition(win: BrowserWindow, settings: SettingsStore): void {
  const saved = settings.get().petPosition;
  const size = { width: FRAME_WIDTH, height: FRAME_HEIGHT };
  if (!saved) {
    // First run: bottom-right corner of the primary display's work area, the
    // classic desktop-pet spot.
    const area = screen.getPrimaryDisplay().workArea;
    win.setPosition(
      area.x + area.width - size.width - 24,
      area.y + area.height - size.height,
    );
    return;
  }
  // Clamp into whichever surviving display is nearest, so a monitor unplugged
  // since last run cannot strand her off-screen.
  const display = screen.getDisplayNearestPoint(saved);
  const clamped = clampIntoWorkArea(saved, size, display.workArea);
  win.setPosition(clamped.x, clamped.y);
}

// Referenced so the bridge type stays the single source of truth for what the
// preload exposes; a preload drift from this type fails its own typecheck.
export type { SandiPetBridge };
