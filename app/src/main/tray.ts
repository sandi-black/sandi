import type { PetOutfit } from "@shared/animation-manifest";
import type { LinkStatus } from "@shared/ipc-contract";
import { app, Menu, nativeImage, Tray } from "electron";

import trayIconPath from "../../build/icons/tray-icon.png?asset";
import type { SettingsStore } from "./settings-store";

// The tray icon is the pet's only conventional chrome: she has no window
// buttons, so showing/hiding her and quitting live here. The Tray instance is
// returned and held by the caller for the app's lifetime; a garbage-collected
// Tray silently vanishes from the notification area.

export type TrayController = {
  tray: Tray;
  setLinkStatus(status: LinkStatus): void;
};

export function createTray(input: {
  settings: SettingsStore;
  onToggleSandi(): void;
  onOpenChat(): void;
  onOutfitChange(outfit: PetOutfit): void;
  onWanderChange(enabled: boolean): void;
}): TrayController {
  const icon = nativeImage.createFromPath(trayIconPath);
  const tray = new Tray(icon);
  tray.setToolTip("Sandi");

  // In a packaged build this is the release tag the CI packaging workflow
  // injected as the app version; in dev it is package.json's own version.
  const version = app.getVersion();
  let linkLabel = "Link: starting...";

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
          label: "Alternate outfit",
          type: "checkbox",
          checked: settings.outfit === "alternate",
          click: (item) => {
            const outfit: PetOutfit = item.checked ? "alternate" : "classic";
            input.settings.update({ outfit });
            input.onOutfitChange(outfit);
            rebuildMenu();
          },
        },
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
