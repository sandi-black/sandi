// Pure model of the auto-updater's lifecycle: what phase the update is in,
// how updater events move it between phases, and what the tray should say
// about it. The Electron wiring (electron-updater for the installed app, a
// GitHub release lookup for the portable exe) lives in updater.ts; keeping
// the transitions and copy here lets verify-update-state.ts exercise them
// without Electron.

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "downloading"; version: string }
  // A newer release exists but this install cannot apply it itself (the
  // portable exe); the human downloads it from the release page.
  | { phase: "available"; version: string }
  // Downloaded and staged; installs on quit, or immediately via the tray.
  | { phase: "ready"; version: string }
  | { phase: "up-to-date" }
  | { phase: "error"; message: string };

export type UpdateEvent =
  | { type: "check-started" }
  | { type: "not-available" }
  // delivery says what happens next: "auto" means the updater is already
  // downloading it (electron-updater with autoDownload), "manual" means the
  // human has to fetch it themselves (the portable exe).
  | { type: "available"; version: string; delivery: "auto" | "manual" }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

// One rule beyond the obvious mapping: "ready" is sticky. A downloaded update
// stays staged on disk across later checks, so a subsequent check-started,
// not-available, available, or error must not take the restart-to-update
// action away; only a newer download replaces it.
export function reduceUpdate(
  state: UpdateState,
  event: UpdateEvent,
): UpdateState {
  if (state.phase === "ready" && event.type !== "downloaded") {
    return state;
  }
  switch (event.type) {
    case "check-started":
      return { phase: "checking" };
    case "not-available":
      return { phase: "up-to-date" };
    case "available":
      return event.delivery === "auto"
        ? { phase: "downloading", version: event.version }
        : { phase: "available", version: event.version };
    case "downloaded":
      return { phase: "ready", version: event.version };
    case "error":
      return { phase: "error", message: event.message };
  }
}

// What the tray renders for the current phase: nothing before the first
// check, otherwise one line, clickable when there is something to do.
// "install" restarts into the staged update; "download" opens the release
// page (the portable exe's manual path). The error line stays terse; the
// full error goes to the console where it can actually be read.
export type UpdateMenuEntry = {
  label: string;
  action?: "install" | "download";
};

export function updateMenuEntry(
  state: UpdateState,
  automaticUpdates = false,
): UpdateMenuEntry | undefined {
  switch (state.phase) {
    case "idle":
      return undefined;
    case "checking":
      return { label: "Checking for updates..." };
    case "downloading":
      return { label: `Downloading ${state.version}...` };
    case "available":
      return { label: `Update ${state.version} available`, action: "download" };
    case "ready":
      return {
        label: automaticUpdates
          ? `Update ${state.version} ready; installs when idle`
          : `Restart to update to ${state.version}`,
        action: "install",
      };
    case "up-to-date":
      return { label: "Sandi is up to date" };
    case "error":
      return { label: "Update check failed" };
  }
}

// Automatic installation is deliberately narrower than ordinary app quit. A
// staged release waits until Sandi has no active or queued work to lose.
export function canInstallAutomatically(input: {
  state: UpdateState;
  automaticUpdates: boolean;
  sandiIdle: boolean;
}): boolean {
  return (
    input.state.phase === "ready" && input.automaticUpdates && input.sandiIdle
  );
}

// Strict-enough semver comparison for release tags: is `candidate` a real
// upgrade over `current`? Fails closed: anything unparsable (a garbled tag, a
// dev placeholder) is "not newer", so a bad feed can never nag the human or
// trigger a download. Build metadata (+...) is ignored per semver; prerelease
// identifiers are compared by the semver rules (numeric before alphanumeric,
// a prerelease sorts below its release).
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (y !== x) return y > x;
  }
  // Same core: a release outranks any prerelease of it.
  if (a.prerelease.length === 0) return false;
  if (b.prerelease.length === 0) return true;
  return comparePrerelease(a.prerelease, b.prerelease) < 0;
}

type Semver = { core: number[]; prerelease: string[] };

function parseSemver(version: string): Semver | undefined {
  const bare = version.startsWith("v") ? version.slice(1) : version;
  const match = bare.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

// Semver 2.0.0 precedence for prerelease identifier lists: numeric
// identifiers compare numerically and rank below alphanumeric ones;
// otherwise lexical; a shorter list that is a prefix of a longer one ranks
// below it. Returns negative when a < b.
function comparePrerelease(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
