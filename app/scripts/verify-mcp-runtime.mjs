import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readRuntimeLock, verifyManifest } from "./mcp-runtime-lib.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("the desktop runtime bundle is verified only on Windows x64");
}

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const appRoot = resolve(import.meta.dirname, "..");
const bundle = join(appRoot, "build", "mcp");
const lock = readRuntimeLock(join(appRoot, "mcp-runtime", "runtime-lock.json"));
const userRoot = mkdtempSync(join(tmpdir(), "sandi-runtime-user-"));

try {
  await verifyManifest(bundle, lock);
  verifyAutoIt(userRoot);

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
  const chromeTools = await listTools(
    electronExecutable,
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
    {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "localhost,127.0.0.1,::1",
    },
    userRoot,
  );
  assert(chromeTools.length > 0, "Chrome DevTools MCP returned no tools");

  const noticesPath = join(bundle, "THIRD_PARTY_NOTICES.json");
  assert(existsSync(noticesPath), "license index is missing");
  verifyNotices(JSON.parse(readFileSync(noticesPath, "utf8")), lock);
  await verifyManifest(bundle, lock);
  console.log(
    `verified desktop runtime bundle: autoit=${lock.commands.autoit.version} chrome-tools=${chromeTools.length}`,
  );
} finally {
  rmSync(userRoot, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 100,
  });
}

function verifyAutoIt(root) {
  const checker = join(bundle, "autoit", "Au3Check.exe");
  assert(existsSync(checker), "AutoIt syntax checker is missing");
  assert(
    existsSync(join(bundle, "autoit", "Au3Check.dat")),
    "AutoIt syntax checker data is missing",
  );
  const facadeCheck = runAu3Check(
    join(bundle, "autoit", "Include", "SandiAutoIt.au3"),
    root,
  );
  assert.equal(facadeCheck.status, 0, facadeCheck.stderr || facadeCheck.stdout);

  const script = join(root, "verify-autoit-success.au3");
  writeFileSync(
    script,
    [
      "#include <AutoItConstants.au3>",
      'ConsoleWrite(@AutoItVersion & "|" & @AutoItX64 & "|" & $BI_ENABLE & @CRLF)',
      "Exit 0",
      "",
    ].join("\r\n"),
  );
  const result = spawnSync(
    join(bundle, "autoit", "AutoIt3_x64.exe"),
    ["/ErrorStdOut", script],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), `${lock.commands.autoit.version}|1|0`);

  const facadeScript = join(root, "verify-autoit-facade.au3");
  writeFileSync(
    facadeScript,
    [
      "#include <SandiAutoIt.au3>",
      "Local $sInspection = SandiUIA_Inspect(HWnd(0), 0)",
      "Local $iInspectionError = @error",
      "ConsoleWrite($iInspectionError & @CRLF)",
      "",
    ].join("\r\n"),
  );
  const facade = runAutoIt(facadeScript, root);
  assert.equal(facade.status, 0, facade.stderr || facade.stdout);
  assert.equal(facade.stdout.trim(), "2");
  const checked = runAu3Check(script, root);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);

  const syntaxScript = join(root, "verify-autoit-syntax.au3");
  writeFileSync(syntaxScript, "This Is Not Valid(\r\n");
  const syntaxCheck = runAu3Check(syntaxScript, root);
  assert.equal(syntaxCheck.status, 2);
  assert.match(syntaxCheck.stdout, /error/i);
  const syntax = runAutoIt(syntaxScript, root);
  assert.equal(syntax.status, 1);
  assert.match(syntax.stdout, /ERROR/);

  const nonzeroScript = join(root, "verify-autoit-nonzero.au3");
  writeFileSync(nonzeroScript, "Exit 7\r\n");
  assert.equal(runAutoIt(nonzeroScript, root).status, 7);

  const controlScript = join(root, "verify-autoit-controls.au3");
  writeFileSync(
    controlScript,
    [
      "#include <GUIConstantsEx.au3>",
      'Local $hWindow = GUICreate("Sandi AutoIt verification", 320, 120)',
      'Local $iInput = GUICtrlCreateInput("", 10, 10, 200, 24)',
      'Local $iButton = GUICtrlCreateButton("Verify", 10, 50, 100, 28)',
      "GUISetState(@SW_SHOW, $hWindow)",
      'If Not ControlSetText($hWindow, "", "Edit1", "Ada Lovelace") Then Exit 11',
      'If ControlGetText($hWindow, "", "Edit1") <> "Ada Lovelace" Then Exit 12',
      'If Not ControlClick($hWindow, "", "Button1") Then Exit 13',
      "Local $hTimer = TimerInit()",
      "Local $iMessage = 0",
      "Do",
      "    $iMessage = GUIGetMsg()",
      "Until $iMessage = $iButton Or TimerDiff($hTimer) > 2000",
      "If $iMessage <> $iButton Then Exit 14",
      'ConsoleWrite("controls=ok" & @CRLF)',
      "GUIDelete($hWindow)",
      "Exit 0",
      "",
    ].join("\r\n"),
  );
  const controls = runAutoIt(controlScript, root);
  assert.equal(controls.status, 0, controls.stderr || controls.stdout);
  assert.equal(controls.stdout.trim(), "controls=ok");
}

function runAu3Check(script, cwd) {
  return spawnSync(
    join(bundle, "autoit", "Au3Check.exe"),
    ["-q", "-d", script],
    { encoding: "utf8", cwd },
  );
}

function runAutoIt(script, cwd) {
  return spawnSync(
    join(bundle, "autoit", "AutoIt3_x64.exe"),
    ["/ErrorStdOut", script],
    { encoding: "utf8", cwd },
  );
}

function verifyNotices(notices, runtimeLock) {
  for (const path of [
    "licenses/autoit.html",
    "servers/chrome-devtools/node_modules/chrome-devtools-mcp/LICENSE",
  ]) {
    assert(
      notices.licenseFiles.includes(path),
      `license index omitted ${path}`,
    );
  }
  for (const [ecosystem, name, version] of [
    ["runtime", "autoit", runtimeLock.commands.autoit.version],
    [
      "npm",
      "chrome-devtools-mcp",
      runtimeLock.commands["chrome-devtools-mcp"].version,
    ],
  ]) {
    assert(
      notices.packages.some(
        (entry) =>
          entry.ecosystem === ecosystem &&
          entry.name === name &&
          entry.version === version &&
          entry.licenseFiles.length > 0,
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
    for (;;) {
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
