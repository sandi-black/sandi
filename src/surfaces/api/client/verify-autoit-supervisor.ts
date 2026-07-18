import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { runSupervisedAutoIt } from "@/surfaces/api/client/autoit-supervisor";

const executableArg = process.argv[2];
if (!executableArg) {
  throw new Error("usage: verify-autoit-supervisor <AutoIt3_x64.exe>");
}
const executable = isAbsolute(executableArg)
  ? executableArg
  : resolve(process.cwd(), executableArg);
assert(existsSync(executable), `AutoIt runtime is missing: ${executable}`);

const root = mkdtempSync(join(tmpdir(), "sandi-autoit-supervisor-"));

try {
  const completed = await runScript(
    [
      'ConsoleWrite("Grace Hopper" & @CRLF)',
      'ConsoleWriteError("expected stderr" & @CRLF)',
      "Exit 7",
    ].join("\r\n"),
    5_000,
  );
  assert.equal(completed.kind, "completed");
  assert.equal(completed.exitCode, 7);
  assert.equal(completed.stdout.trim(), "Grace Hopper");
  assert.equal(completed.stderr.trim(), "expected stderr");

  const truncated = await runScript(
    ["For $index = 1 To 5000", '    ConsoleWrite("x")', "Next"].join("\r\n"),
    5_000,
    1_000,
  );
  assert.equal(truncated.kind, "completed");
  assert.equal(truncated.stdout.length, 1_000);
  assert.equal(truncated.truncated, true);

  const marker = join(root, "timeout-child.pid");
  const descendantActive = join(root, "timeout-child.active");
  const descendant = join(root, "timeout-child.au3");
  writeFileSync(
    descendant,
    [
      `FileWrite(${autoItString(descendantActive)}, "active")`,
      "While True",
      "    Sleep(100)",
      "WEnd",
    ].join("\r\n"),
    "utf8",
  );
  const timedOutRun = runScript(
    [
      `Local $pid = Run('"' & @AutoItExe & '" /ErrorStdOut "' & ${autoItString(descendant)} & '"', "", @SW_HIDE)`,
      `FileWrite(${autoItString(marker)}, $pid)`,
      "While True",
      "    Sleep(100)",
      "WEnd",
    ].join("\r\n"),
    1_500,
  );
  await waitUntil(
    () => existsSync(descendantActive),
    "active timed-out descendant",
  );
  const timedOut = await timedOutRun;
  assert.equal(timedOut.kind, "timed_out");
  const childPid = Number(await waitForFile(marker));
  assert(Number.isSafeInteger(childPid) && childPid > 0);
  await waitUntil(
    () => !isProcessRunning(childPid),
    "timed-out descendant cleanup",
  );

  const active = join(root, "cancel-active.marker");
  const controller = new AbortController();
  const cancelledRun = runScript(
    [
      `FileWrite(${autoItString(active)}, "active")`,
      "While True",
      "    Sleep(100)",
      "WEnd",
    ].join("\r\n"),
    5_000,
    40_000,
    controller.signal,
  );
  await waitUntil(() => existsSync(active), "active cancellation marker");
  controller.abort();
  const cancelled = await cancelledRun;
  assert.equal(cancelled.kind, "cancelled");

  const clipboardSeed = runDirect([
    'ClipPut("Grace clipboard")',
    "ConsoleWrite(ClipGet() & @CRLF)",
  ]);
  assert.equal(clipboardSeed.status, 0, clipboardSeed.stderr);
  assert.equal(clipboardSeed.stdout.trim(), "Grace clipboard");
  const clipboardActive = join(root, "clipboard-cancel-active.marker");
  const clipboardController = new AbortController();
  const clipboardCancellation = runScript(
    [
      "#include <SandiAutoIt.au3>",
      "Local $timer = TimerInit()",
      'If Not __SandiEditor_SetClipboard("temporary clipboard", $timer) Then Exit 21',
      'DllCall("user32.dll", "none", "keybd_event", "byte", 0x11, "byte", 0, "dword", 0, "ulong_ptr", 0)',
      `FileWrite(${autoItString(clipboardActive)}, "active")`,
      "While True",
      "    Sleep(100)",
      "WEnd",
    ].join("\r\n"),
    10_000,
    40_000,
    clipboardController.signal,
  );
  await waitUntil(
    () => existsSync(clipboardActive),
    "active clipboard cancellation marker",
  );
  clipboardController.abort();
  assert.equal((await clipboardCancellation).kind, "cancelled");
  const clipboardAfterCancel = runDirect([
    'Local $control = DllCall("user32.dll", "short", "GetAsyncKeyState", "int", 0x11)',
    'DllCall("user32.dll", "none", "keybd_event", "byte", 0x11, "byte", 0, "dword", 2, "ulong_ptr", 0)',
    'ConsoleWrite(ClipGet() & "|" & BitAND($control[0], 0x8000) & @CRLF)',
  ]);
  assert.equal(clipboardAfterCancel.status, 0, clipboardAfterCancel.stderr);
  assert.equal(clipboardAfterCancel.stdout.trim(), "Grace clipboard|0");

  console.log("AutoIt supervisor verification passed");
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 50,
  });
}

function runDirect(lines: readonly string[]) {
  const runDir = mkdtempSync(join(root, "direct-"));
  const artifact = join(runDir, "main.au3");
  writeFileSync(artifact, `${lines.join("\r\n")}\r\n`, "utf8");
  return spawnSync(executable, ["/ErrorStdOut", artifact], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function runScript(
  source: string,
  timeoutMs: number,
  maxOutputChars = 40_000,
  signal?: AbortSignal,
) {
  const runDir = mkdtempSync(join(root, "run-"));
  const artifact = join(runDir, "main.au3");
  writeFileSync(artifact, `${source}\r\n`, "utf8");
  return runSupervisedAutoIt({
    executable,
    artifact,
    runDir,
    cwd: root,
    env: process.env,
    timeoutMs,
    maxOutputChars,
    elevation: "inherit",
    ...(signal !== undefined ? { signal } : {}),
  });
}

async function waitForFile(path: string): Promise<string> {
  await waitUntil(() => existsSync(path), path);
  return readFileSync(path, "utf8");
}

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
