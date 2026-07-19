import type { LinkStatus } from "@shared/ipc-contract";
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Tray,
} from "electron";

import trayIconPath from "../../build/icons/tray-icon.png?asset";
import type { SettingsStore } from "./settings-store";
import { type UpdateState, updateMenuEntry } from "./update-state";

// The tray icon is the pet's only conventional chrome: she has no window
// buttons, so showing/hiding her and quitting live here. The Tray instance is
// returned and held by the caller for the app's lifetime; a garbage-collected
// Tray silently vanishes from the notification area.

export type TrayController = {
  tray: Tray;
  setLinkStatus(status: LinkStatus): void;
  setUpdateState(state: UpdateState): void;
};

// Present only when an updater exists for this install (packaged builds);
// a dev run has no update section at all.
export type TrayUpdates = {
  initialState: UpdateState;
  onCheck(): void;
  // Restart into the staged update (the installed app's "ready" line).
  onInstall(): void;
  // Open the release download page (the portable exe's "available" line).
  onDownload(): void;
  onAutoUpdateChange(enabled: boolean): void;
};

export function createTray(input: {
  settings: SettingsStore;
  onToggleSandi(): void;
  onOpenChat(): void;
  onWanderChange(enabled: boolean): void;
  updates?: TrayUpdates;
}): TrayController {
  const icon = nativeImage.createFromPath(trayIconPath);
  const tray = new Tray(icon);
  tray.setToolTip("Sandi");

  // In a packaged build this is the release tag the CI packaging workflow
  // injected as the app version; in dev it is package.json's own version.
  const version = app.getVersion();
  let linkLabel = "Link: starting...";
  let updateState = input.updates?.initialState ?? { phase: "idle" };

  // The update section of the menu: the status line for the current phase
  // (clickable when there is something to do), the manual check, and the
  // automatic-check toggle. Empty in dev, where no updater exists.
  const updateItems = (): MenuItemConstructorOptions[] => {
    const updates = input.updates;
    if (!updates) return [];
    const entry = updateMenuEntry(updateState, input.settings.get().autoUpdate);
    const busy =
      updateState.phase === "checking" || updateState.phase === "downloading";
    return [
      ...(entry
        ? [
            {
              label: entry.label,
              enabled: entry.action !== undefined,
              click: () => {
                if (entry.action === "install") updates.onInstall();
                if (entry.action === "download") updates.onDownload();
              },
            },
          ]
        : []),
      { label: "Check for updates", enabled: !busy, click: updates.onCheck },
      {
        label: "Update automatically",
        type: "checkbox",
        checked: input.settings.get().autoUpdate,
        click: (item) => {
          input.settings.update({ autoUpdate: item.checked });
          updates.onAutoUpdateChange(item.checked);
          rebuildMenu();
        },
      },
    ];
  };

  const rebuildMenu = (): void => {
    const settings = input.settings.get();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: linkLabel, enabled: false },
        { type: "separator" },
        { label: "Open chat", click: () => input.onOpenChat() },
        { label: "Show/hide Sandi", click: () => input.onToggleSandi() },
        { type: "separator" },
        {
          label: "Wander",
          type: "checkbox",
          checked: settings.wander,
          click: (item) => {
            input.settings.update({ wander: item.checked });
            input.onWanderChange(item.checked);
            rebuildMenu();
          },
        },
        {
          label: "Start with Windows",
          type: "checkbox",
          checked: settings.autoLaunch,
          click: (item) => {
            input.settings.update({ autoLaunch: item.checked });
            // In dev this would register the bare electron binary; the
            // preference still persists and applies on a packaged launch.
            if (app.isPackaged) {
              app.setLoginItemSettings({ openAtLogin: item.checked });
            }
            rebuildMenu();
          },
        },
        { type: "separator" },
        { label: `Sandi ${version}`, enabled: false },
        ...updateItems(),
        { label: "Quit Sandi", click: () => app.quit() },
      ]),
    );
  };

  // Windows convention: left click is the primary action (toggle the pet),
  // right click opens the context menu, which Electron shows automatically
  // for the assigned menu.
  tray.on("click", () => input.onToggleSandi());
  rebuildMenu();

  return {
    tray,
    setLinkStatus(status) {
      linkLabel = describeLink(status);
      tray.setToolTip(`Sandi (${linkLabel.toLowerCase()})`);
      rebuildMenu();
    },
    setUpdateState(state) {
      updateState = state;
      rebuildMenu();
    },
  };
}

function describeLink(status: LinkStatus): string {
  switch (status.state) {
    case "unpaired":
      return "Link: not paired";
    case "connecting":
      return "Link: connecting...";
    case "linked":
      return "Link: connected";
    case "dropped":
      return `Link: dropped${status.message ? ` (${status.message})` : ""}`;
  }
}
