import { app } from "electron";
// electron-updater is a CommonJS package whose named exports are lazy
// getters; the default-import-then-destructure form is the one shape that
// survives both the rollup bundle and tsc.
import electronUpdater from "electron-updater";

import {
  canInstallAutomatically,
  isNewerVersion,
  reduceUpdate,
  type UpdateEvent,
  type UpdateState,
} from "./update-state";
import { z } from "zod/v4";

// Keeps an existing install current with the GitHub Releases the packaging
// workflow publishes. Three flavors of install, three behaviors:
//
// - installed (the NSIS setup): electron-updater checks the release feed
//   (latest.yml, addressed via the publish block in electron-builder.yml),
//   downloads in the background, and stages the update to apply on quit; the
//   tray also offers an immediate restart-and-install.
// - portable: the exe cannot replace itself, so this only looks up the latest
//   release tag and points the human at the download page.
// - dev: no updater at all (index.ts never creates one).
//
// With automatic updates enabled, checks run shortly after launch and then on
// a slow cycle. An installed update applies once Sandi has no active or queued
// work. The tray's manual check and install actions always remain available.

const GITHUB_OWNER = "sandi-black";
const GITHUB_REPO = "sandi";
export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// The first check waits out the launch rush (icon build, link connect,
// renderer load) instead of competing with it.
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const PORTABLE_CHECK_TIMEOUT_MS = 15_000;
const AUTO_INSTALL_RETRY_MS = 30_000;

export type UpdateFlavor = "installed" | "portable" | "dev";

// electron-builder's portable launcher sets this for the child process; it is
// the documented way to tell the portable exe apart from the installed app.
export function detectUpdateFlavor(): UpdateFlavor {
  if (!app.isPackaged) return "dev";
  if (process.env["PORTABLE_EXECUTABLE_FILE"]) return "portable";
  return "installed";
}

export type UpdaterController = {
  state(): UpdateState;
  // Manual check from the tray; a no-op while a check or download is running.
  checkNow(): void;
  // Installs the staged update immediately. Meaningful only in the "ready"
  // phase; the tray only wires it to the ready line.
  quitAndInstall(): void;
  // Follows the autoUpdate setting: gates scheduled checks and idle-time
  // installation. Manual checks and manual installation remain available.
  setAutomaticUpdates(enabled: boolean): void;
  dispose(): void;
};

type UpdaterInput = {
  automaticUpdates: boolean;
  onState(state: UpdateState): void;
} & (
  | {
      flavor: "installed";
      isSandiIdle(): boolean;
    }
  | { flavor: "portable" }
);

export function createUpdater(input: UpdaterInput): UpdaterController {
  let state: UpdateState = { phase: "idle" };
  let automaticUpdates = input.automaticUpdates;
  let disposed = false;
  let installRetry: NodeJS.Timeout | undefined;

  const stopInstallRetry = (): void => {
    if (installRetry) clearTimeout(installRetry);
    installRetry = undefined;
  };

  const scheduleAutomaticInstall = (delayMs: number): void => {
    stopInstallRetry();
    if (
      disposed ||
      input.flavor !== "installed" ||
      !automaticUpdates ||
      state.phase !== "ready"
    ) {
      return;
    }
    installRetry = setTimeout(() => {
      installRetry = undefined;
      tryAutomaticInstall();
    }, delayMs);
  };

  const tryAutomaticInstall = (): void => {
    if (
      disposed ||
      input.flavor !== "installed" ||
      !automaticUpdates ||
      state.phase !== "ready"
    ) {
      return;
    }
    if (
      canInstallAutomatically({
        state,
        automaticUpdates,
        sandiIdle: input.isSandiIdle(),
      })
    ) {
      // Silent mode keeps NSIS from showing UI or taking focus. forceRunAfter
      // makes the relaunch explicit for that mode.
      electronUpdater.autoUpdater.quitAndInstall(true, true);
      return;
    }
    scheduleAutomaticInstall(AUTO_INSTALL_RETRY_MS);
  };

  const dispatch = (event: UpdateEvent): void => {
    const next = reduceUpdate(state, event);
    if (next === state) return;
    state = next;
    input.onState(state);
    if (state.phase === "ready") scheduleAutomaticInstall(0);
  };

  const check =
    input.flavor === "installed"
      ? createInstalledCheck(dispatch)
      : createPortableCheck(dispatch);

  const checkNow = (): void => {
    // One check at a time; "downloading" also covers the window where a
    // second checkForUpdates could confuse electron-updater's staging.
    if (state.phase === "checking" || state.phase === "downloading") return;
    check();
  };

  let firstCheck: NodeJS.Timeout | undefined;
  let cycle: NodeJS.Timeout | undefined;
  const stopTimers = (): void => {
    if (firstCheck) clearTimeout(firstCheck);
    if (cycle) clearInterval(cycle);
    firstCheck = undefined;
    cycle = undefined;
  };
  const setAutomaticUpdates = (enabled: boolean): void => {
    automaticUpdates = enabled;
    stopTimers();
    if (!enabled) {
      stopInstallRetry();
      return;
    }
    firstCheck = setTimeout(checkNow, FIRST_CHECK_DELAY_MS);
    cycle = setInterval(checkNow, CHECK_INTERVAL_MS);
    if (state.phase === "ready") scheduleAutomaticInstall(0);
  };
  setAutomaticUpdates(input.automaticUpdates);

  return {
    state: () => state,
    checkNow,
    quitAndInstall() {
      if (input.flavor !== "installed" || state.phase !== "ready") return;
      // quitAndInstall quits the app itself, which fires before-quit, so the
      // hidden-not-closed windows and the device link tear down normally.
      electronUpdater.autoUpdater.quitAndInstall();
    },
    setAutomaticUpdates,
    dispose() {
      disposed = true;
      stopTimers();
      stopInstallRetry();
    },
  };
}

// The installed app delegates everything to electron-updater: it reads the
// feed location from the app-update.yml electron-builder embeds at package
// time, downloads as soon as a newer release shows up, and stages it to
// install on quit.
function createInstalledCheck(
  dispatch: (event: UpdateEvent) => void,
): () => void {
  const updater = electronUpdater.autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = console;

  updater.on("checking-for-update", () => dispatch({ type: "check-started" }));
  updater.on("update-not-available", () => dispatch({ type: "not-available" }));
  updater.on("update-available", (info) =>
    dispatch({ type: "available", version: info.version, delivery: "auto" }),
  );
  updater.on("update-downloaded", (info) =>
    dispatch({ type: "downloaded", version: info.version }),
  );
  updater.on("error", (error) => {
    console.error("update check failed", error);
    dispatch({ type: "error", message: error.message });
  });

  return () => {
    // Errors surface through the "error" event above; this catch only stops
    // the duplicate unhandled-rejection noise.
    updater.checkForUpdates().catch(() => {});
  };
}

// The portable exe only asks GitHub what the latest release is: the public
// releases/latest endpoint returns the tag, and the strict local comparison
// decides whether it is actually newer.
const LatestReleaseSchema = z.object({ tag_name: z.string() });

function createPortableCheck(
  dispatch: (event: UpdateEvent) => void,
): () => void {
  return () => {
    dispatch({ type: "check-started" });
    lookUpLatestTag()
      .then((tag) => {
        if (isNewerVersion(app.getVersion(), tag)) {
          const version = tag.startsWith("v") ? tag.slice(1) : tag;
          dispatch({ type: "available", version, delivery: "manual" });
        } else {
          dispatch({ type: "not-available" });
        }
      })
      .catch((error: unknown) => {
        console.error("update check failed", error);
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "error", message });
      });
  };
}

async function lookUpLatestTag(): Promise<string> {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: {
      accept: "application/vnd.github+json",
      // GitHub's API rejects requests without a User-Agent.
      "user-agent": "sandi-desktop",
    },
    // The wall-clock deadline covers DNS, headers, and reading/parsing the
    // response so the tray cannot remain in "checking" forever.
    signal: AbortSignal.timeout(PORTABLE_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`release lookup returned ${response.status}`);
  }
  return LatestReleaseSchema.parse(await response.json()).tag_name;
}
