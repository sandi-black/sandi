import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { UUID } from "builder-util-runtime";

import { readRuntimeLock, verifyManifest } from "./mcp-runtime-lib.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("the installer lifecycle is verified only on Windows x64");
}
const systemRoot = process.env.SystemRoot;
assert(systemRoot, "SystemRoot is required to verify the Windows installer");

const appRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8"),
);
const builderConfig = readFileSync(
  join(appRoot, "electron-builder.yml"),
  "utf8",
);
const appId = /^appId:\s*(\S+)\s*$/m.exec(builderConfig)?.[1];
assert(appId, "electron-builder.yml is missing appId");
const appGuid = UUID.v5(
  appId,
  UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"),
);
const setup = join(
  appRoot,
  "release",
  `Sandi-${packageJson.version}-setup.exe`,
);
const testRoot = mkdtempSync(join(tmpdir(), "sandi-nsis-"));
const installDir = join(testRoot, "installed Sandi");
const lock = readRuntimeLock(join(appRoot, "mcp-runtime", "runtime-lock.json"));
const tsxCli = resolve(appRoot, "..", "node_modules", "tsx", "dist", "cli.mjs");
const registryKeys = [
  `HKCU\\Software\\${appGuid}`,
  `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid}`,
];
const registryBackups = snapshotRegistry();

try {
  clearRegistry();
  verifyLaunchedUninstallerFailure();
  clearRegistry();
  seedUninstallRecord(join(testRoot, "missing old uninstaller.exe"));
  install();
  await verifyInstalledBundle();
  runAppSmoke();
  await waitForInstalledProcesses();
  await verifyInstalledBundle();

  writeFileSync(
    join(installDir, "resources", "mcp", "node", "node.exe"),
    "corrupt runtime",
  );
  runAppSmoke("failed verification");
  await waitForInstalledProcesses();

  // electron-updater marks an in-place replacement so NSIS takes its update
  // path instead of treating the existing installation as a fresh install.
  install(true);
  await verifyInstalledBundle();

  const uninstaller = join(installDir, "Uninstall Sandi.exe");
  assert(existsSync(uninstaller), "NSIS did not install its uninstaller");
  run(uninstaller, ["/S"]);
  await waitUntil(() => !existsSync(installDir), "NSIS uninstall cleanup");
  console.log(
    "verified NSIS handling for stale records and failed uninstallers, plus install, repair update, corruption refusal, and uninstall",
  );
} finally {
  try {
    await uninstallIfPresent();
  } finally {
    try {
      restoreRegistry();
    } finally {
      rmSync(testRoot, {
        recursive: true,
        force: true,
        maxRetries: 200,
        retryDelay: 100,
      });
    }
  }
}

function verifyLaunchedUninstallerFailure() {
  const failingUninstaller = join(testRoot, "failing old uninstaller.exe");
  copyFileSync(join(systemRoot, "System32", "where.exe"), failingUninstaller);
  seedUninstallRecord(failingUninstaller);

  const result = spawn(setup, ["/S", `/D=${installDir}`]);
  assert.equal(
    result.status,
    2,
    "NSIS must fail when the old uninstaller launches and returns nonzero",
  );
  assert(
    !existsSync(join(installDir, "Sandi.exe")),
    "NSIS continued after the old uninstaller failed",
  );
  rmSync(installDir, { recursive: true, force: true });
}

function seedUninstallRecord(uninstaller) {
  const installLocation = join(testRoot, "old Sandi");
  regAdd(registryKeys[0], "InstallLocation", installLocation);
  regAdd(registryKeys[1], "DisplayName", "Sandi lifecycle fixture");
  regAdd(registryKeys[1], "UninstallString", `"${uninstaller}"`);
}

function regAdd(key, name, value) {
  run("reg.exe", ["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
}

function snapshotRegistry() {
  return registryKeys.flatMap((key, index) => {
    const query = spawn("reg.exe", ["query", key], "ignore");
    if (query.status === 1) return [];
    assert.equal(query.status, 0, `failed to inspect registry key ${key}`);

    const backup = join(testRoot, `registry-${String(index)}.reg`);
    run("reg.exe", ["export", key, backup, "/y"]);
    return [backup];
  });
}

function clearRegistry() {
  for (const key of registryKeys) {
    const result = spawn("reg.exe", ["delete", key, "/f"], "ignore");
    assert(
      result.status === 0 || result.status === 1,
      `failed to delete registry key ${key}`,
    );
  }
}

function restoreRegistry() {
  clearRegistry();
  for (const backup of registryBackups) {
    run("reg.exe", ["import", backup]);
  }
}

function install(updated = false) {
  run(setup, [...(updated ? ["--updated"] : []), "/S", `/D=${installDir}`]);
  assert(
    existsSync(join(installDir, "Sandi.exe")),
    "NSIS install is missing Sandi.exe",
  );
}

async function uninstallIfPresent() {
  const uninstaller = join(installDir, "Uninstall Sandi.exe");
  if (!existsSync(uninstaller)) return;

  try {
    await waitForInstalledProcesses();
    spawnSync(uninstaller, ["/S"], {
      cwd: appRoot,
      env: process.env,
      stdio: "ignore",
    });
    await waitUntil(() => !existsSync(installDir), "fallback NSIS uninstall");
  } catch {
    // The outer cleanup still removes the isolated test root. Never mask the
    // lifecycle failure with a second cleanup failure.
  }
}

async function waitForInstalledProcesses() {
  await waitUntil(
    () => installedProcessCount() === 0,
    "installed Sandi processes to exit",
  );
}

function installedProcessCount() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:SANDI_INSTALL_ROOT, [System.StringComparison]::OrdinalIgnoreCase) }).Count",
    ],
    {
      env: { ...process.env, SANDI_INSTALL_ROOT: installDir },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`failed to inspect installed processes: ${result.stderr}`);
  }
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(count)) {
    throw new Error(`invalid installed process count: ${result.stdout}`);
  }
  return count;
}

async function verifyInstalledBundle() {
  await verifyManifest(join(installDir, "resources", "mcp"), lock);
}

function runAppSmoke(expectedError) {
  run(
    process.execPath,
    [
      tsxCli,
      "--tsconfig",
      "tsconfig.node.json",
      "scripts/verify-packaged-app-mcp.ts",
    ],
    {
      ...process.env,
      SANDI_PACKAGED_APP_ROOT: installDir,
      ...(expectedError ? { SANDI_EXPECT_BUNDLED_ERROR: expectedError } : {}),
    },
  );
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${String(result.status)}`,
    );
  }
}

function spawn(command, args, stdio = "inherit") {
  return spawnSync(command, args, {
    cwd: appRoot,
    env: process.env,
    stdio,
    windowsHide: true,
  });
}

async function waitUntil(condition, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
