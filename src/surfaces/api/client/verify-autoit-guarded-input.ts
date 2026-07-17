import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  throw new Error("usage: verify-autoit-guarded-input <AutoIt3_x64.exe>");
}
const executable = isAbsolute(executableArg)
  ? executableArg
  : resolve(process.cwd(), executableArg);
assert(existsSync(executable), `AutoIt runtime is missing: ${executable}`);

const root = mkdtempSync(join(tmpdir(), "sandi-autoit-input-"));
const compileProbe = join(root, "compile-probe.au3");
writeFileSync(
  compileProbe,
  [
    "#include <AutoItConstants.au3>",
    "#include <String.au3>",
    "#include <SandiAutoIt.au3>",
    'If False Then SandiInput_TypeText(HWnd(0), 0, "", $SANDI_UIA_EDIT, "", "first line" & @CRLF & _StringRepeat("x", 4000))',
    'If False Then Send("release-probe", $SEND_RAW)',
    'ConsoleWrite("compile=ok")',
    "",
  ].join("\r\n"),
  "utf8",
);
const compiled = runAutoIt(compileProbe);
if (compiled.status !== 0 || compiled.stdout.trim() !== "compile=ok") {
  rmSync(root, { recursive: true, force: true });
  throw new Error(compiled.stderr || compiled.stdout || "compile probe failed");
}
const adminProbe = join(root, "is-admin.au3");
writeFileSync(adminProbe, "ConsoleWrite(Number(IsAdmin()))\r\n", "utf8");
const admin = runAutoIt(adminProbe);
if (admin.status !== 0 || admin.stdout.trim() !== "1") {
  rmSync(root, { recursive: true, force: true });
  throw new Error(
    "guarded-input verification requires an already-elevated terminal and never requests UAC",
  );
}

const ready = join(root, "fixture.ready");
const mode = join(root, "fixture.mode");
const modeReady = join(root, "fixture.mode-ready");
const state = join(root, "fixture.state");
const focusChanged = join(root, "focus.changed");
const fixturePath = join(root, "fixture.au3");
let fixtureModeSequence = 0;
writeFileSync(
  fixturePath,
  inputFixture({ ready, mode, modeReady, state, focusChanged }),
  "utf8",
);
const fixture = spawn(executable, ["/ErrorStdOut", fixturePath], {
  stdio: "ignore",
  windowsHide: true,
});

try {
  await waitUntil(() => existsSync(ready), "input fixture readiness");
  const identity = readFileSync(ready, "utf8").trim();

  await setFixtureMode("focus-change");
  const focusScript = writeScript(
    "focus-change.au3",
    guardedSource(identity, [
      'Local $bTyped = SandiInput_TypeText($hWnd, $iPid, "3", $SANDI_UIA_EDIT, "", "12345678abcdefghABCDEFGH")',
      "Local $iInputError = @error",
      "If $bTyped Or $iInputError <> $SANDI_INPUT_ERROR_TARGET Then Exit 20",
      'ConsoleWrite("focus-refusal=ok" & @CRLF)',
    ]),
  );
  const focus = runAutoIt(focusScript, 15_000);
  assert.equal(focus.status, 0, focus.stderr || focus.stdout);
  assert.equal(focus.stdout.trim(), "focus-refusal=ok");
  await waitUntil(() => existsSync(focusChanged), "programmatic focus change");
  const focusState = readState();
  assert(focusState.primary.length >= 8);
  assert(focusState.primary.length < 24);
  assert.equal(focusState.decoy, "");

  await setFixtureMode("reset");
  await setFixtureMode("cancel");
  const active = join(root, "cancel.active");
  const controller = new AbortController();
  const cancelledRun = runScript(
    guardedSource(identity, [
      `FileWrite(${autoItString(active)}, "active")`,
      'SandiInput_TypeText($hWnd, $iPid, "3", $SANDI_UIA_EDIT, "", "first line" & @CRLF & _StringRepeat("x", 4000))',
    ]),
    20_000,
    controller.signal,
  );
  let earlyResult: Awaited<typeof cancelledRun> | undefined;
  void cancelledRun.then((result) => {
    earlyResult = result;
  });
  await waitUntil(() => {
    if (earlyResult !== undefined) {
      throw new Error(
        `guarded input exited before cancellation became active: ${JSON.stringify(earlyResult)}`,
      );
    }
    return existsSync(active) && readState().primary.length > 0;
  }, "active multiline guarded input");
  controller.abort();
  const cancelled = await cancelledRun;
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(readState().decoy, "");
  assert(!readState().primary.endsWith("x".repeat(4000)));

  await verifyInputReleased(identity);
  console.log("AutoIt guarded-input verification passed");
} finally {
  if (fixture.pid !== undefined) {
    spawnSync("taskkill.exe", ["/pid", String(fixture.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  }
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 50,
  });
}

async function verifyInputReleased(identity: string): Promise<void> {
  await setFixtureMode("reset");
  const probe = writeScript(
    "release-probe.au3",
    [
      "#include <AutoItConstants.au3>",
      fixtureIdentity(identity, [
        "WinActivate($hWnd)",
        'If Not WinWaitActive($hWnd, "", 3) Then Exit 30',
        'If Not ControlFocus($hWnd, "", "Edit1") Then Exit 31',
        'Send("release-probe", $SEND_RAW)',
      ]),
    ].join("\r\n"),
  );
  const released = runAutoIt(probe);
  assert.equal(released.status, 0, released.stderr || released.stdout);
  await waitUntil(
    () => readState().primary === "release-probe",
    "input-release probe",
  );
}

function inputFixture(paths: {
  ready: string;
  mode: string;
  modeReady: string;
  state: string;
  focusChanged: string;
}): string {
  return `#include <GUIConstantsEx.au3>

Local $hWindow = GUICreate("Sandi guarded input target", 420, 180, 120, 120)
Local $iPrimary = GUICtrlCreateInput("", 20, 20, 360, 24)
Local $iDecoy = GUICtrlCreateInput("", 20, 65, 360, 24)
GUISetState(@SW_SHOW, $hWindow)
FileWrite(${autoItString(paths.ready)}, Number($hWindow) & "|" & @AutoItPID)
Local $sLastState = ""
Local $sLastMode = ""

While True
    If GUIGetMsg() = $GUI_EVENT_CLOSE Then ExitLoop
    Local $sMode = StringStripWS(FileRead(${autoItString(paths.mode)}), 3)
    Local $iModeSeparator = StringInStr($sMode, "|")
    Local $sAction = $sMode
    If $iModeSeparator > 0 Then $sAction = StringLeft($sMode, $iModeSeparator - 1)
    If $sMode <> $sLastMode Then
        If $sAction = "reset" Then
            GUICtrlSetData($iPrimary, "")
            GUICtrlSetData($iDecoy, "")
            GUICtrlSetState($iPrimary, $GUI_FOCUS)
        ElseIf $sAction = "focus-change" Then
            GUICtrlSetData($iPrimary, "")
            GUICtrlSetData($iDecoy, "")
            GUICtrlSetState($iPrimary, $GUI_FOCUS)
        ElseIf $sAction = "cancel" Then
            GUICtrlSetData($iPrimary, "")
            GUICtrlSetData($iDecoy, "")
            GUICtrlSetState($iPrimary, $GUI_FOCUS)
        EndIf
        $sLastMode = $sMode
        Local $hModeReady = FileOpen(${autoItString(paths.modeReady)}, 2)
        FileWrite($hModeReady, $sMode)
        FileClose($hModeReady)
    EndIf
    If $sAction = "focus-change" And StringLen(GUICtrlRead($iPrimary)) >= 8 And _
            Not FileExists(${autoItString(paths.focusChanged)}) Then
        GUICtrlSetState($iDecoy, $GUI_FOCUS)
        FileWrite(${autoItString(paths.focusChanged)}, "changed")
    EndIf
    Local $sState = GUICtrlRead($iPrimary) & @LF & GUICtrlRead($iDecoy)
    If $sState <> $sLastState Then
        Local $hState = FileOpen(${autoItString(paths.state)}, 2)
        FileWrite($hState, $sState)
        FileClose($hState)
        $sLastState = $sState
    EndIf
    Sleep(1)
WEnd
`;
}

function guardedSource(identity: string, lines: string[]): string {
  return [
    "#include <String.au3>",
    "#include <SandiAutoIt.au3>",
    ...fixtureIdentity(identity, lines).trimEnd().split("\r\n"),
    "",
  ].join("\r\n");
}

function fixtureIdentity(identity: string, lines: string[]): string {
  const [window, pid] = identity.split("|");
  assert(window && pid, "fixture identity is malformed");
  return [
    `Local $hWnd = HWnd(${window})`,
    `Local $iPid = ${pid}`,
    "WinActivate($hWnd)",
    'If Not WinWaitActive($hWnd, "", 3) Then Exit 10',
    'If Not ControlFocus($hWnd, "", "Edit1") Then Exit 11',
    ...lines,
    "Exit 0",
    "",
  ].join("\r\n");
}

function writeScript(name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, "utf8");
  return path;
}

function runAutoIt(script: string, timeout = 10_000) {
  return spawnSync(executable, ["/ErrorStdOut", script], {
    cwd: root,
    encoding: "utf8",
    timeout,
  });
}

function runScript(source: string, timeoutMs: number, signal?: AbortSignal) {
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
    maxOutputChars: 40_000,
    elevation: "inherit",
    ...(signal !== undefined ? { signal } : {}),
  });
}

function readState(): { primary: string; decoy: string } {
  const [primary = "", decoy = ""] = existsSync(state)
    ? readFileSync(state, "utf8").split(/\r?\n/, 2)
    : [];
  return { primary, decoy };
}

async function setFixtureMode(action: string): Promise<void> {
  const command = `${action}|${++fixtureModeSequence}`;
  writeFileSync(mode, command, "utf8");
  await waitUntil(
    () =>
      existsSync(modeReady) &&
      readFileSync(modeReady, "utf8").trim() === command,
    `${action} fixture acknowledgement`,
  );
}

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
