import assert from "node:assert/strict";

import {
  canInstallAutomatically,
  isNewerVersion,
  reduceUpdate,
  type UpdateState,
  updateMenuEntry,
} from "./update-state";

// Exercises the pure updater model: the phase transitions (including the
// sticky "ready" rule), the tray menu copy for each phase, and the version
// comparison the portable exe's release lookup relies on.
// Run with: npm run verify:update-state -w app

const idle: UpdateState = { phase: "idle" };

function testAutoDownloadFlow(): void {
  let state = reduceUpdate(idle, { type: "check-started" });
  assert.deepEqual(state, { phase: "checking" });
  state = reduceUpdate(state, {
    type: "available",
    version: "0.2.0",
    delivery: "auto",
  });
  assert.deepEqual(state, { phase: "downloading", version: "0.2.0" });
  state = reduceUpdate(state, { type: "downloaded", version: "0.2.0" });
  assert.deepEqual(state, { phase: "ready", version: "0.2.0" });
}

function testManualDownloadFlow(): void {
  let state = reduceUpdate(idle, { type: "check-started" });
  state = reduceUpdate(state, {
    type: "available",
    version: "0.2.0",
    delivery: "manual",
  });
  assert.deepEqual(
    state,
    { phase: "available", version: "0.2.0" },
    "a manual-delivery update waits for the human instead of downloading",
  );
}

function testUpToDateAndError(): void {
  assert.deepEqual(
    reduceUpdate({ phase: "checking" }, { type: "not-available" }),
    { phase: "up-to-date" },
  );
  assert.deepEqual(
    reduceUpdate({ phase: "checking" }, { type: "error", message: "offline" }),
    { phase: "error", message: "offline" },
  );
  assert.deepEqual(
    reduceUpdate(
      { phase: "error", message: "offline" },
      { type: "check-started" },
    ),
    { phase: "checking" },
    "a fresh check clears an old error",
  );
}

function testReadyIsSticky(): void {
  const ready: UpdateState = { phase: "ready", version: "0.2.0" };
  assert.equal(
    reduceUpdate(ready, { type: "check-started" }),
    ready,
    "a later check does not take the staged update away",
  );
  assert.equal(reduceUpdate(ready, { type: "not-available" }), ready);
  assert.equal(
    reduceUpdate(ready, {
      type: "available",
      version: "0.3.0",
      delivery: "auto",
    }),
    ready,
    "the staged update stays installable while a newer one downloads",
  );
  assert.equal(
    reduceUpdate(ready, { type: "error", message: "offline" }),
    ready,
  );
  assert.deepEqual(
    reduceUpdate(ready, { type: "downloaded", version: "0.3.0" }),
    { phase: "ready", version: "0.3.0" },
    "only a newer download replaces the staged one",
  );
}

function testMenuEntries(): void {
  assert.equal(updateMenuEntry(idle), undefined, "quiet before any check");
  assert.deepEqual(updateMenuEntry({ phase: "checking" }), {
    label: "Checking for updates...",
  });
  assert.deepEqual(
    updateMenuEntry({ phase: "downloading", version: "0.2.0" }),
    { label: "Downloading 0.2.0..." },
  );
  assert.deepEqual(updateMenuEntry({ phase: "available", version: "0.2.0" }), {
    label: "Update 0.2.0 available",
    action: "download",
  });
  assert.deepEqual(updateMenuEntry({ phase: "ready", version: "0.2.0" }), {
    label: "Restart to update to 0.2.0",
    action: "install",
  });
  assert.deepEqual(
    updateMenuEntry({ phase: "ready", version: "0.2.0" }, true),
    {
      label: "Update 0.2.0 ready; installs when idle",
      action: "install",
    },
  );
  assert.deepEqual(updateMenuEntry({ phase: "up-to-date" }), {
    label: "Sandi is up to date",
  });
  assert.deepEqual(
    updateMenuEntry({ phase: "error", message: "socket hang up" }),
    { label: "Update check failed" },
    "the error line stays terse; the full message goes to the console",
  );
}

function testAutomaticInstallGate(): void {
  const ready: UpdateState = { phase: "ready", version: "0.2.0" };
  const allowed = {
    state: ready,
    automaticUpdates: true,
    sandiIdle: true,
  };
  assert.equal(canInstallAutomatically(allowed), true);
  assert.equal(
    canInstallAutomatically({ ...allowed, state: { phase: "checking" } }),
    false,
  );
  assert.equal(
    canInstallAutomatically({ ...allowed, automaticUpdates: false }),
    false,
  );
  assert.equal(
    canInstallAutomatically({ ...allowed, sandiIdle: false }),
    false,
  );
}

function testVersionComparison(): void {
  // Plain upgrades and non-upgrades.
  assert.equal(isNewerVersion("0.1.1", "0.2.0"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.2"), true);
  assert.equal(isNewerVersion("0.1.1", "1.0.0"), true);
  assert.equal(isNewerVersion("0.1.1", "0.1.1"), false);
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), false);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), false);
  // Numeric, not lexical: 0.10.0 > 0.9.0.
  assert.equal(isNewerVersion("0.9.0", "0.10.0"), true);
  // A leading v (the release tag shape) parses on either side.
  assert.equal(isNewerVersion("0.1.1", "v0.2.0"), true);
  assert.equal(isNewerVersion("v0.2.0", "v0.2.0"), false);
  // Prerelease ordering per semver: a prerelease sorts below its release,
  // numeric identifiers compare numerically and below alphanumeric ones, and
  // a longer identifier list outranks its prefix.
  assert.equal(isNewerVersion("1.0.0-beta", "1.0.0"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0-beta"), false);
  assert.equal(isNewerVersion("1.0.0-alpha", "1.0.0-beta"), true);
  assert.equal(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.11"), true);
  assert.equal(isNewerVersion("1.0.0-1", "1.0.0-alpha"), true);
  assert.equal(isNewerVersion("1.0.0-alpha", "1.0.0-alpha.1"), true);
  // Build metadata does not affect precedence.
  assert.equal(isNewerVersion("1.0.0+build.5", "1.0.0+build.9"), false);
  // Fail closed: garbage on either side is never an upgrade.
  assert.equal(isNewerVersion("0.1.1", "latest"), false);
  assert.equal(isNewerVersion("0.1.1", "0.2"), false);
  assert.equal(isNewerVersion("dev", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.1", ""), false);
}

function main(): void {
  testAutoDownloadFlow();
  testManualDownloadFlow();
  testUpToDateAndError();
  testReadyIsSticky();
  testMenuEntries();
  testAutomaticInstallGate();
  testVersionComparison();
  console.log("verify-update-state: ok");
}

main();
