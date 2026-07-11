import { join } from "node:path";

import type { ResizeEdge } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { BrowserWindow, ipcMain, screen } from "electron";

import { ResizeEdgeSchema } from "./ipc-schemas";
import { parseRendererDevServerUrl } from "./renderer-url";
import type { SettingsStore } from "./settings-store";
import {
  clampSizeIntoWorkArea,
  computeAnchoredPosition,
  computeOffsetPosition,
  computeResizedBounds,
  type Point,
  type Size,
} from "./window-anchor";
import { lockWindowToRenderer } from "./window-navigation";

// The popover chat window. Created hidden at startup and shown/hidden for the
// rest of the app's life: closing hides, and only the tray's Quit destroys.
// It deliberately has no blur handler; unlike a standard popover it stays up
// when clicked away, and only an explicit close dismisses it.
//
// The human may move it (the header is a drag region) and resize it. Both
// choices persist: the size as-is, the position as an offset from the pet's
// top-left, so the popover reopens beside her wherever she has wandered and
// trails her at the chosen offset while she is dragged. Until the first move
// or resize, the default anchored placement applies.

const DEFAULT_SIZE: Size = { width: 400, height: 600 };
// Room for the header, a few transcript lines, the composer, and the status
// bar; below this the layout crushes rather than scrolls.
const MIN_SIZE: Size = { width: 320, height: 360 };
// moved/resized fire once per completed gesture; the debounce only coalesces
// a quick move-then-resize into a single settings write.
const SAVE_DEBOUNCE_MS = 400;

export type ChatWindow = {
  window: BrowserWindow;
  openNear(petBounds: Electron.Rectangle): void;
  toggleNear(petBounds: Electron.Rectangle): void;
  // Re-anchor to the pet's current bounds, but only while already visible, so
  // the popover trails her as she is dragged. A no-op when hidden.
  follow(petBounds: Electron.Rectangle): void;
  hide(): void;
};

export function createChatWindow(input: {
  isQuitting(): boolean;
  settings: SettingsStore;
}): ChatWindow {
  const { settings } = input;

  // The human's chosen geometry, live in memory and persisted debounced. An
  // undefined offset means they have never moved or resized the popover.
  let userSize: Size = settings.get().chatSize ?? DEFAULT_SIZE;
  let userOffset: Point | undefined = settings.get().chatOffset;

  // The pet's top-left as of the last programmatic placement: the reference
  // that turns a gesture's absolute position back into an offset. Fresh
  // whenever it matters, because every open and every pet move while the
  // popover is visible passes through position().
  let petReference: Point | undefined;

  // True while position() applies programmatic bounds; the moved/resized
  // listeners skip those so only real gestures are recorded as intent.
  let positioning = false;

  const win = new BrowserWindow({
    width: userSize.width,
    height: userSize.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
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
  lockWindowToRenderer(win);
  win.setAlwaysOnTop(true, "screen-saver");

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const flushSave = (): void => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    settings.update({
      chatSize: userSize,
      ...(userOffset ? { chatOffset: userOffset } : {}),
    });
  };
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  };

  // A move records only the offset; a resize records both, because resizing
  // from the left or top edge shifts the origin too. Size deliberately stays
  // untouched on plain moves so dragging the popover around a temporarily
  // small display (where position() clamped the applied size) does not
  // overwrite the preferred size with the clamped one.
  const recordMove = (): void => {
    if (positioning || !petReference) return;
    const bounds = win.getBounds();
    userOffset = {
      x: bounds.x - petReference.x,
      y: bounds.y - petReference.y,
    };
    scheduleSave();
  };
  const recordResize = (): void => {
    if (positioning) return;
    const bounds = win.getBounds();
    userSize = { width: bounds.width, height: bounds.height };
    if (petReference) {
      userOffset = {
        x: bounds.x - petReference.x,
        y: bounds.y - petReference.y,
      };
    }
    scheduleSave();
  };
  win.on("moved", recordMove);
  win.on("resized", recordResize);

  // An OS-level close (Alt+F4) hides like the in-app close button; the window
  // is only allowed to die when the app is quitting for real. A quit also
  // flushes any geometry save still sitting in the debounce window.
  win.on("close", (event) => {
    if (input.isQuitting()) {
      flushSave();
      return;
    }
    event.preventDefault();
    win.hide();
  });

  ipcMain.on(IPC.chatClose, (event) => {
    if (event.sender !== win.webContents) return;
    win.hide();
  });

  // Manual resize, mirroring the pet's manual drag: Windows drops
  // WS_THICKFRAME from transparent windows, so there is no native resize
  // frame and the renderer's edge grips drive it instead. The renderer only
  // reports grip, tick, and release; main re-reads the true cursor from the
  // screen module each tick, which also sidesteps renderer-to-screen DPI
  // coordinate mismatches.
  let resizeGrip:
    | { edge: ResizeEdge; cursor: Point; bounds: Electron.Rectangle }
    | undefined;
  ipcMain.on(IPC.chatResizeStart, (event, payload) => {
    if (event.sender !== win.webContents) return;
    const parsed = ResizeEdgeSchema.safeParse(payload);
    if (!parsed.success) return;
    resizeGrip = {
      edge: parsed.data,
      cursor: screen.getCursorScreenPoint(),
      bounds: win.getBounds(),
    };
  });
  ipcMain.on(IPC.chatResizeMove, (event) => {
    if (event.sender !== win.webContents) return;
    if (!resizeGrip) return;
    const cursor = screen.getCursorScreenPoint();
    const next = computeResizedBounds(
      resizeGrip.bounds,
      resizeGrip.edge,
      {
        x: cursor.x - resizeGrip.cursor.x,
        y: cursor.y - resizeGrip.cursor.y,
      },
      MIN_SIZE,
    );
    // Guarded like position(): the gesture is recorded once at release, not
    // per tick.
    positioning = true;
    try {
      win.setBounds(next, false);
    } finally {
      positioning = false;
    }
  });
  ipcMain.on(IPC.chatResizeEnd, (event) => {
    if (event.sender !== win.webContents) return;
    if (!resizeGrip) return;
    const started = resizeGrip.bounds;
    resizeGrip = undefined;
    // A grip clicked without movement is not intent: recording it would
    // freeze the default anchored placement into a fixed offset for nothing.
    const bounds = win.getBounds();
    if (
      bounds.x === started.x &&
      bounds.y === started.y &&
      bounds.width === started.width &&
      bounds.height === started.height
    ) {
      return;
    }
    recordResize();
  });

  const position = (petBounds: Electron.Rectangle): void => {
    petReference = { x: petBounds.x, y: petBounds.y };
    const display = screen.getDisplayNearestPoint({
      x: petBounds.x,
      y: petBounds.y,
    });
    const size = clampSizeIntoWorkArea(userSize, MIN_SIZE, display.workArea);
    const point = userOffset
      ? computeOffsetPosition(petBounds, userOffset, size, display.workArea)
      : computeAnchoredPosition(petBounds, size, display.workArea);
    // setBounds reasserting the size rather than setPosition: `follow`
    // repositions the popover every frame while the pet is dragged, and plain
    // setPosition on a fractional-DPI Windows display inflates the window a
    // little on each call (see moveWindow in pet-window.ts for the mechanism).
    positioning = true;
    try {
      win.setBounds(
        { x: point.x, y: point.y, width: size.width, height: size.height },
        false,
      );
    } finally {
      positioning = false;
    }
  };

  loadRenderer(win).catch((error: unknown) => {
    console.error("chat renderer failed to load", error);
  });

  return {
    window: win,
    openNear(petBounds) {
      position(petBounds);
      win.show();
      win.focus();
    },
    toggleNear(petBounds) {
      if (win.isVisible()) {
        win.hide();
        return;
      }
      position(petBounds);
      win.show();
      win.focus();
    },
    follow(petBounds) {
      if (!win.isVisible()) return;
      position(petBounds);
    },
    hide() {
      win.hide();
    },
  };
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
