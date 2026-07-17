import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  buildManifest,
  readRuntimeLock,
  sha256File,
  verifyManifest,
} from "./mcp-runtime-lib.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("the desktop runtime bundle is prepared only on Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(appRoot, "mcp-runtime");
const lock = readRuntimeLock(join(sourceRoot, "runtime-lock.json"));
const buildRoot = join(appRoot, "build");
const cacheRoot = join(buildRoot, "mcp-cache");
const destination = join(buildRoot, "mcp");
const staging = join(buildRoot, `.mcp-stage-${randomUUID()}`);
const extractionRoot = join(staging, ".extract");

rmSync(staging, { recursive: true, force: true });
mkdirSync(extractionRoot, { recursive: true });

try {
  const autoitArchive = await downloadVerified("autoit", lock.artifacts.autoit);
  const autoitLicense = await downloadVerified(
    "autoit-license",
    lock.artifacts.autoit.license,
  );
  const licenseDir = join(staging, "licenses");
  mkdirSync(licenseDir, { recursive: true });
  copyFileSync(autoitLicense, join(licenseDir, "autoit.html"));

  const extracted = extractZip(autoitArchive, join(extractionRoot, "autoit"));
  const autoitSource = join(extracted, lock.artifacts.autoit.archiveRoot);
  const autoitDestination = join(staging, "autoit");
  mkdirSync(autoitDestination, { recursive: true });
  copyFileSync(
    join(autoitSource, "AutoIt3_x64.exe"),
    join(autoitDestination, "AutoIt3_x64.exe"),
  );
  cpSync(join(autoitSource, "Include"), join(autoitDestination, "Include"), {
    recursive: true,
  });

  const chromeDir = join(staging, "servers", "chrome-devtools");
  mkdirSync(chromeDir, { recursive: true });
  copyFileSync(
    join(sourceRoot, "chrome-devtools", "package.json"),
    join(chromeDir, "package.json"),
  );
  copyFileSync(
    join(sourceRoot, "chrome-devtools", "package-lock.json"),
    join(chromeDir, "package-lock.json"),
  );
  const npmCli = process.env["npm_execpath"];
  if (!npmCli) {
    throw new Error("npm_execpath is required to prepare the Chrome runtime");
  }
  run(
    process.execPath,
    [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    chromeDir,
  );

  rmSync(extractionRoot, { recursive: true, force: true });
  writeThirdPartyIndex(staging);
  const manifest = await buildManifest(staging, lock);
  writeFileSync(
    join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await verifyManifest(staging, lock);
  promote(staging, destination);
  console.log(
    `prepared desktop runtime bundle with ${manifest.files.length} files`,
  );
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}

async function downloadVerified(name, artifact) {
  mkdirSync(cacheRoot, { recursive: true });
  const path = join(
    cacheRoot,
    `${name}-${artifact.sha256}-${basename(new URL(artifact.url).pathname)}`,
  );
  if (!existsSync(path)) {
    const response = await fetch(artifact.url);
    if (!response.ok) {
      throw new Error(`failed to download ${name}: HTTP ${response.status}`);
    }
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const actual = await sha256File(path);
  if (actual !== artifact.sha256) {
    rmSync(path, { force: true });
    throw new Error(
      `${name} SHA256 mismatch: expected ${artifact.sha256}, got ${actual}`,
    );
  }
  return path;
}

function extractZip(zip, destinationDir) {
  mkdirSync(destinationDir, { recursive: true });
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:SANDI_RUNTIME_ZIP -DestinationPath $env:SANDI_RUNTIME_DEST -Force",
    ],
    {
      env: {
        ...process.env,
        SANDI_RUNTIME_ZIP: zip,
        SANDI_RUNTIME_DEST: destinationDir,
      },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) throw new Error(`failed to extract ${zip}`);
  return destinationDir;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${String(result.status)}`,
    );
  }
}

function writeThirdPartyIndex(root) {
  const chromeRoot = join(
    root,
    "servers",
    "chrome-devtools",
    "node_modules",
    "chrome-devtools-mcp",
  );
  const chrome = JSON.parse(
    readFileSync(join(chromeRoot, "package.json"), "utf8"),
  );
  const notices = {
    version: 1,
    packages: [
      {
        ecosystem: "runtime",
        name: "autoit",
        version: lock.artifacts.autoit.version,
        license: "AutoIt EULA",
        licenseFiles: ["licenses/autoit.html"],
      },
      {
        ecosystem: "npm",
        name: chrome.name,
        version: chrome.version,
        license: chrome.license,
        licenseFiles: [
          "servers/chrome-devtools/node_modules/chrome-devtools-mcp/LICENSE",
        ],
      },
    ],
    licenseFiles: [
      "licenses/autoit.html",
      "servers/chrome-devtools/node_modules/chrome-devtools-mcp/LICENSE",
    ],
  };
  for (const path of notices.licenseFiles) {
    if (!existsSync(join(root, ...path.split("/")))) {
      throw new Error(`required bundled license is missing: ${path}`);
    }
  }
  writeFileSync(
    join(root, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify(notices, null, 2)}\n`,
  );
}

function promote(staged, target) {
  const previous = `${target}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, previous);
  try {
    renameSync(staged, target);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(previous) && !existsSync(target))
      renameSync(previous, target);
    throw error;
  }
}
