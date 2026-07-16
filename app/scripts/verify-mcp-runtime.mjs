import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readRuntimeLock, verifyManifest } from "./mcp-runtime-lib.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("the MCP runtime bundle is verified only on Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const bundle = join(appRoot, "build", "mcp");
const lock = readRuntimeLock(join(appRoot, "mcp-runtime", "runtime-lock.json"));
const userRoot = mkdtempSync(join(tmpdir(), "sandi-mcp-runtime-user-"));

try {
  await verifyManifest(bundle, lock);

  const node = join(bundle, "node", "node.exe");
  const uv = join(bundle, "uv", "uv.exe");
  const python = join(bundle, "python", "python.exe");
  assert.equal(
    runVersion(node, ["--version"]),
    `v${lock.commands.node.version}`,
  );
  assert.match(
    runVersion(uv, ["--version"]),
    new RegExp(`^uv ${lock.commands.uv.version}`),
  );
  assert.match(
    runVersion(python, ["--version"]),
    new RegExp(`^Python ${lock.commands.python.version}`),
  );

  const chromePackage = JSON.parse(
    readFileSync(
      join(
        bundle,
        "servers",
        "chrome-devtools",
        "node_modules",
        "chrome-devtools-mcp",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    chromePackage.version,
    lock.commands["chrome-devtools-mcp"].version,
  );
  const windowsMetadata = readFileSync(
    join(
      bundle,
      "servers",
      "windows-mcp",
      "site-packages",
      `windows_mcp-${lock.commands["windows-mcp"].version}.dist-info`,
      "METADATA",
    ),
    "utf8",
  );
  assert.match(
    windowsMetadata,
    new RegExp(`^Version: ${lock.commands["windows-mcp"].version}$`, "m"),
  );

  const offlineEnv = {
    ...process.env,
    PATH: [
      join(bundle, "node"),
      process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "",
    ]
      .filter(Boolean)
      .join(";"),
    npm_config_offline: "true",
    UV_OFFLINE: "1",
    PIP_NO_INDEX: "1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    NODE_OPTIONS: `--use-env-proxy --import=${pathToFileURL(join(import.meta.dirname, "offline-network-guard.mjs")).href}`,
    SANDI_MCP_OFFLINE_TEST: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
  };
  assertOfflineGuard(node, offlineEnv);

  const chromeTools = await listTools(
    node,
    [
      join(
        bundle,
        "servers",
        "chrome-devtools",
        "node_modules",
        "chrome-devtools-mcp",
        "build",
        "src",
        "bin",
        "chrome-devtools-mcp.js",
      ),
      "--headless",
    ],
    offlineEnv,
    userRoot,
  );
  assert(chromeTools.length > 0, "Chrome DevTools MCP returned no tools");

  const windowsTools = await listTools(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    ["/d", "/s", "/c", join(bundle, "servers", "windows-mcp", "launch.cmd")],
    offlineEnv,
    userRoot,
  );
  assert(windowsTools.length > 0, "Windows-MCP returned no tools");

  const noticesPath = join(bundle, "THIRD_PARTY_NOTICES.json");
  assert(existsSync(noticesPath), "license index is missing");
  verifyNotices(JSON.parse(readFileSync(noticesPath, "utf8")), lock);
  await verifyManifest(bundle, lock);
  console.log(
    `verified MCP runtime bundle: chrome-tools=${chromeTools.length} windows-tools=${windowsTools.length}`,
  );
} finally {
  rmSync(userRoot, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 100,
  });
}

function runVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} version check failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function assertOfflineGuard(node, env) {
  const directSocket = spawnSync(
    node,
    [
      "-e",
      'const net = require("node:net"); new net.Socket().connect(443, "example.com")',
    ],
    { encoding: "utf8", env },
  );
  assert.notEqual(
    directSocket.status,
    0,
    "offline socket guard allowed egress",
  );
  assert.match(directSocket.stderr, /offline MCP verification blocked/);

  const fetch = spawnSync(
    node,
    ["-e", 'fetch("https://example.com").then(() => process.exit(91))'],
    { encoding: "utf8", env },
  );
  assert.notEqual(fetch.status, 91, "offline proxy guard allowed egress");
}

function verifyNotices(notices, runtimeLock) {
  for (const entry of notices.packages) {
    assert(
      entry.licenseFiles.length > 0,
      `license index has no text for ${entry.ecosystem}:${entry.name}@${entry.version}`,
    );
  }
  for (const path of [
    "licenses/node.txt",
    "licenses/python.txt",
    "licenses/uv.txt",
    "servers/chrome-devtools/node_modules/chrome-devtools-mcp/LICENSE",
    "servers/windows-mcp/site-packages/windows_mcp-0.8.2.dist-info/licenses/LICENSE.md",
  ]) {
    assert(
      notices.licenseFiles.includes(path),
      `license index omitted ${path}`,
    );
  }
  const expected = [
    ["runtime", "node", runtimeLock.artifacts.node.version],
    ["runtime", "python", runtimeLock.artifacts.python.version],
    ["runtime", "uv", runtimeLock.artifacts.uv.version],
    [
      "npm",
      "chrome-devtools-mcp",
      runtimeLock.commands["chrome-devtools-mcp"].version,
    ],
    ["python", "windows-mcp", runtimeLock.commands["windows-mcp"].version],
  ];
  for (const [ecosystem, name, version] of expected) {
    assert(
      notices.packages.some(
        (entry) =>
          entry.ecosystem === ecosystem &&
          entry.name === name &&
          entry.version === version &&
          (entry.license || entry.licenseFiles.length > 0),
      ),
      `license index omitted ${ecosystem}:${name}@${version}`,
    );
  }
}

async function listTools(command, args, env, userDataRoot) {
  const child = spawn(command, args, {
    env: {
      ...env,
      USERPROFILE: userDataRoot,
      LOCALAPPDATA: join(userDataRoot, "Local"),
      APPDATA: join(userDataRoot, "Roaming"),
      SANDI_MCP_STATE_DIR: join(userDataRoot, "mcp-state"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise((resolveClosed) =>
    child.once("close", resolveClosed),
  );
  let stdout = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  const request = (id, method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(
          new Error(`${method} timed out; stderr=${stderr.slice(-2000)}`),
        );
      }, 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error)
          rejectRequest(new Error(JSON.stringify(message.error)));
        else resolveRequest(message.result);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  try {
    await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sandi-runtime-verifier", version: "1.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const result = await request(2, "tools/list", {});
    return result.tools;
  } finally {
    child.stdin.end();
    if (child.pid !== undefined) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    }
    await closed;
  }
}
