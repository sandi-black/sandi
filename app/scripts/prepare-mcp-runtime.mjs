import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
  throw new Error("the MCP runtime bundle is prepared only on Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(appRoot, "mcp-runtime");
const lockPath = join(sourceRoot, "runtime-lock.json");
const lock = readRuntimeLock(lockPath);
const buildRoot = join(appRoot, "build");
const cacheRoot = join(buildRoot, "mcp-cache");
const destination = join(buildRoot, "mcp");
const staging = join(buildRoot, `.mcp-stage-${randomUUID()}`);
const extractionRoot = join(staging, ".extract");

rmSync(staging, { recursive: true, force: true });
mkdirSync(extractionRoot, { recursive: true });

try {
  const downloads = {};
  for (const [name, artifact] of Object.entries(lock.artifacts)) {
    downloads[name] = await downloadVerified(name, artifact);
    const license = await downloadVerified(`${name}-license`, artifact.license);
    const licenseDir = join(staging, "licenses");
    mkdirSync(licenseDir, { recursive: true });
    copyFileSync(license, join(licenseDir, `${name}.txt`));
  }

  const nodeExtracted = extractZip(
    downloads.node,
    join(extractionRoot, "node"),
  );
  cpSync(
    join(nodeExtracted, lock.artifacts.node.archiveRoot),
    join(staging, "node"),
    {
      recursive: true,
    },
  );
  const uvExtracted = extractZip(downloads.uv, join(extractionRoot, "uv"));
  mkdirSync(join(staging, "uv"), { recursive: true });
  for (const executable of ["uv.exe", "uvx.exe"]) {
    copyFileSync(
      join(uvExtracted, executable),
      join(staging, "uv", executable),
    );
  }
  const pythonDir = join(staging, "python");
  extractZip(downloads.python, pythonDir);

  const chromeDir = join(staging, "servers", "chrome-devtools");
  mkdirSync(chromeDir, { recursive: true });
  cpSync(
    join(sourceRoot, "chrome-devtools", "package.json"),
    join(chromeDir, "package.json"),
  );
  cpSync(
    join(sourceRoot, "chrome-devtools", "package-lock.json"),
    join(chromeDir, "package-lock.json"),
  );
  const stagedNode = join(staging, "node", "node.exe");
  const stagedNpmCli = join(
    staging,
    "node",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  run(
    stagedNode,
    [
      stagedNpmCli,
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    chromeDir,
  );

  const windowsDir = join(staging, "servers", "windows-mcp");
  const sitePackages = join(windowsDir, "site-packages");
  mkdirSync(sitePackages, { recursive: true });
  run(
    join(staging, "uv", "uv.exe"),
    [
      "pip",
      "install",
      "--python-version",
      lock.artifacts.python.version,
      "--python-platform",
      "x86_64-pc-windows-msvc",
      "--target",
      sitePackages,
      "--only-binary=:all:",
      "--require-hashes",
      "--no-cache",
      "-r",
      join(sourceRoot, "windows-mcp", "requirements.lock"),
    ],
    appRoot,
  );
  copyFileSync(
    join(sourceRoot, "windows-mcp", "launch.cmd"),
    join(windowsDir, "launch.cmd"),
  );
  copyFileSync(
    join(sourceRoot, "windows-mcp", "launch.py"),
    join(windowsDir, "launch.py"),
  );
  // comtypes creates this module before honoring its redirected generator path.
  // Shipping it up front keeps the installed runtime immutable during use.
  const comtypesGen = join(sitePackages, "comtypes", "gen");
  mkdirSync(comtypesGen, { recursive: true });
  writeFileSync(join(comtypesGen, "__init__.py"), "");
  enableEmbeddedSitePackages(pythonDir);

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
    `prepared MCP runtime bundle with ${manifest.files.length} files`,
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
    if (!response.ok)
      throw new Error(`failed to download ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(path, bytes);
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
      "Expand-Archive -LiteralPath $env:SANDI_MCP_ZIP -DestinationPath $env:SANDI_MCP_DEST -Force",
    ],
    {
      env: {
        ...process.env,
        SANDI_MCP_ZIP: zip,
        SANDI_MCP_DEST: destinationDir,
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

function enableEmbeddedSitePackages(pythonDir) {
  const pth = ["python313._pth", "python._pth"]
    .map((name) => join(pythonDir, name))
    .find(existsSync);
  if (!pth) throw new Error("embedded Python path file is missing");
  const lines = readFileSync(pth, "utf8")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line !== "#import site" && line !== "import site" && line.length > 0,
    );
  lines.push(
    "../servers/windows-mcp/site-packages",
    "../servers/windows-mcp/site-packages/win32",
    "../servers/windows-mcp/site-packages/win32/lib",
    "../servers/windows-mcp/site-packages/Pythonwin",
    "import site",
  );
  writeFileSync(pth, `${lines.join("\r\n")}\r\n`);
}

function writeThirdPartyIndex(root) {
  const licenses = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        directory === join(root, "licenses") ||
        /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name)
      ) {
        licenses.push(path.slice(root.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  licenses.sort();
  for (const required of [
    "licenses/node.txt",
    "licenses/python.txt",
    "licenses/uv.txt",
    "servers/chrome-devtools/node_modules/chrome-devtools-mcp/LICENSE",
    "servers/windows-mcp/site-packages/windows_mcp-0.8.2.dist-info/licenses/LICENSE.md",
  ]) {
    if (!licenses.includes(required)) {
      throw new Error(`required bundled license is missing: ${required}`);
    }
  }
  const packages = collectBundledPackages(root, licenses);
  writeFileSync(
    join(root, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify({ version: 1, packages, licenseFiles: licenses }, null, 2)}\n`,
  );
}

function collectBundledPackages(root, licenses) {
  const packages = [
    runtimePackage("node", lock.artifacts.node.version, "licenses/node.txt"),
    runtimePackage(
      "python",
      lock.artifacts.python.version,
      "licenses/python.txt",
    ),
    runtimePackage("uv", lock.artifacts.uv.version, "licenses/uv.txt"),
  ];
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
  packages.push({
    ecosystem: "npm",
    name: chrome.name,
    version: chrome.version,
    license: chrome.license,
    licenseFiles: licenses.filter((path) =>
      path.startsWith(
        "servers/chrome-devtools/node_modules/chrome-devtools-mcp/",
      ),
    ),
  });

  const sitePackages = join(root, "servers", "windows-mcp", "site-packages");
  for (const entry of readdirSync(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
    const metadata = readFileSync(
      join(sitePackages, entry.name, "METADATA"),
      "utf8",
    );
    const name = metadata.match(/^Name:\s*(.+)$/m)?.[1];
    const version = metadata.match(/^Version:\s*(.+)$/m)?.[1];
    const declaredLicense =
      metadata.match(/^License-Expression:\s*(.+)$/m)?.[1] ??
      metadata.match(/^License:\s*(.+)$/m)?.[1] ??
      [...metadata.matchAll(/^Classifier:\s*License :: (.+)$/gm)]
        .map((match) => match[1])
        .join("; ");
    const prefix = `servers/windows-mcp/site-packages/${entry.name}/`;
    const packageLicenses = licenses.filter((path) => path.startsWith(prefix));
    if (
      !name ||
      !version ||
      (!declaredLicense && packageLicenses.length === 0)
    ) {
      throw new Error(
        `Python package notice metadata is incomplete: ${entry.name}`,
      );
    }
    packages.push({
      ecosystem: "python",
      name,
      version,
      license: declaredLicense || null,
      licenseFiles: packageLicenses,
    });
  }
  const fastmcp = packages.find(
    (entry) => entry.ecosystem === "python" && entry.name === "fastmcp",
  );
  const fastmcpSlim = packages.find(
    (entry) => entry.ecosystem === "python" && entry.name === "fastmcp-slim",
  );
  // fastmcp-slim is built from the same Apache-2.0 project but omits the
  // duplicate license file from its wheel, so point it at fastmcp's copy.
  if (fastmcpSlim?.licenseFiles.length === 0 && fastmcp?.licenseFiles.length) {
    fastmcpSlim.licenseFiles = [...fastmcp.licenseFiles];
  }
  for (const entry of packages) {
    if (entry.licenseFiles.length === 0) {
      throw new Error(
        `bundled package has no indexed license text: ${entry.ecosystem}:${entry.name}@${entry.version}`,
      );
    }
  }
  return packages.sort((left, right) =>
    `${left.ecosystem}:${left.name}`.localeCompare(
      `${right.ecosystem}:${right.name}`,
    ),
  );
}

function runtimePackage(name, version, licenseFile) {
  return {
    ecosystem: "runtime",
    name,
    version,
    license: null,
    licenseFiles: [licenseFile],
  };
}

function promote(source, target) {
  const backup = `${target}.old-${randomUUID()}`;
  if (existsSync(target)) renameWithRetry(target, backup);
  try {
    renameWithRetry(source, target);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(backup) && !existsSync(target))
      renameWithRetry(backup, target);
    throw error;
  }
}

function renameWithRetry(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (attempt >= 20 || error?.code !== "EPERM") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
