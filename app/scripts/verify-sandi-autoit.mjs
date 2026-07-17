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
import { join, resolve } from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("SandiAutoIt verification requires Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const runtime = join(appRoot, "build", "mcp", "autoit", "AutoIt3_x64.exe");
const root = mkdtempSync(join(tmpdir(), "sandi-autoit-uia-"));
const ready = join(root, "fixture.ready");
const applied = join(root, "applied.txt");
const toggled = join(root, "toggled.txt");
const selected = join(root, "selected.txt");
const remove = join(root, "remove-temp");
const removed = join(root, "temp-removed");
const fixturePath = join(root, "fixture.au3");
const driverPath = join(root, "driver.au3");
let fixture;

try {
  writeFileSync(
    fixturePath,
    autoItFixture({ ready, applied, toggled, selected, remove, removed }),
  );
  writeFileSync(
    driverPath,
    autoItDriver({ ready, applied, toggled, selected, remove, removed }),
  );
  fixture = spawn(runtime, ["/ErrorStdOut", fixturePath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let fixtureError = "";
  fixture.stderr.setEncoding("utf8");
  fixture.stderr.on("data", (chunk) => {
    fixtureError += chunk;
  });
  await waitUntil(
    () => existsSync(ready),
    () => `AutoIt fixture readiness; stderr=${fixtureError}`,
  );

  const result = spawnSync(runtime, ["/ErrorStdOut", driverPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "uia=ok");
  assert.match(result.stderr, /ambiguous selector/);
  assert.match(result.stderr, /automationId="7"/);
  assert.match(result.stderr, /automationId="8"/);
  assert.equal(readFileSync(applied, "utf8"), "Grace Hopper");
  assert.equal(readFileSync(toggled, "utf8"), "1");
  assert.equal(readFileSync(selected, "utf8"), "Ada Lovelace");
  console.log("SandiAutoIt UIA verification passed");
} finally {
  if (fixture?.pid !== undefined) {
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

function autoItFixture(paths) {
  return `#include <GUIConstantsEx.au3>

Local $hTarget = GUICreate("Sandi UIA target", 500, 320, 80, 80)
Local $iEdit = GUICtrlCreateInput("", 20, 20, 240, 24)
Local $iApply = GUICtrlCreateButton("Apply change", 20, 60, 110, 28)
Local $iCheck = GUICtrlCreateCheckbox("Enable feature", 150, 64, 120, 24)
Local $iList = GUICtrlCreateList("", 20, 105, 240, 80)
GUICtrlSetData($iList, "Ada Lovelace|Grace Hopper")
Local $iDuplicateOne = GUICtrlCreateButton("Duplicate", 290, 20, 130, 28)
Local $iDuplicateTwo = GUICtrlCreateButton("Duplicate", 290, 60, 130, 28)
Local $iTemporary = GUICtrlCreateButton("Temporary action", 290, 100, 130, 28)
GUISetState(@SW_SHOW, $hTarget)

Local $hDecoy = GUICreate("Sandi UIA foreground guard", 260, 120, 640, 80)
GUISetState(@SW_SHOW, $hDecoy)
WinActivate($hDecoy)
FileWrite(${autoItString(paths.ready)}, Number($hTarget) & "|" & Number($hDecoy) & "|" & @AutoItPID)

Local $bRemoved = False
While True
    Local $aMessage = GUIGetMsg(1)
    Switch $aMessage[0]
        Case $GUI_EVENT_CLOSE
            ExitLoop
        Case $iApply
            FileWrite(${autoItString(paths.applied)}, GUICtrlRead($iEdit))
        Case $iCheck
            FileWrite(${autoItString(paths.toggled)}, String(GUICtrlRead($iCheck)))
        Case $iList
            FileWrite(${autoItString(paths.selected)}, GUICtrlRead($iList))
    EndSwitch
    If Not $bRemoved And FileExists(${autoItString(paths.remove)}) Then
        GUICtrlDelete($iTemporary)
        GUICtrlCreateButton("Replacement action", 290, 100, 130, 28)
        FileWrite(${autoItString(paths.removed)}, "removed")
        $bRemoved = True
    EndIf
    If Not FileExists(${autoItString(paths.selected)}) And GUICtrlRead($iList) <> "" Then _
            FileWrite(${autoItString(paths.selected)}, GUICtrlRead($iList))
    Sleep(10)
WEnd
`;
}

function autoItDriver(paths) {
  return `#include <SandiAutoIt.au3>

Local $aFixture = StringSplit(StringStripWS(FileRead(${autoItString(paths.ready)}), 3), "|", 2)
If UBound($aFixture) <> 3 Then Exit 10
Local $hTarget = HWnd(Number($aFixture[0]))
Local $hDecoy = HWnd(Number($aFixture[1]))
Local $iPid = Number($aFixture[2])
WinActivate($hDecoy)
If Not WinWaitActive($hDecoy, "", 3) Then Exit 11
If WinGetHandle("[ACTIVE]") = $hTarget Then Exit 12

Local $sEditDescription = SandiUIA_Describe($hTarget, $iPid, "3", $SANDI_UIA_EDIT, "")
If $sEditDescription = "" Then Exit 20
If SandiUIA_Describe($hTarget, $iPid, "9", $SANDI_UIA_BUTTON, "Temporary action") = "" Then Exit 21
FileWrite(${autoItString(paths.remove)}, "remove")
If Not __WaitFor(${autoItString(paths.removed)}) Then Exit 22
Local $bStaleInvoke = SandiUIA_Invoke($hTarget, $iPid, "9", $SANDI_UIA_BUTTON, "Temporary action")
Local $iStaleError = @error
If $bStaleInvoke Then Exit 23
If $iStaleError <> $SANDI_UIA_ERROR_NOT_FOUND Then
    ConsoleWriteError("staleError=" & $iStaleError & @CRLF)
    Exit 24
EndIf

If Not SandiUIA_SetValue($hTarget, $iPid, "3", $SANDI_UIA_EDIT, "", "Grace Hopper") Then Exit 30
If SandiUIA_GetValue($hTarget, $iPid, "3", $SANDI_UIA_EDIT, "") <> "Grace Hopper" Then Exit 31
WinActivate($hDecoy)
If Not WinWaitActive($hDecoy, "", 3) Then Exit 32
If Not SandiUIA_Invoke($hTarget, $iPid, "4", $SANDI_UIA_BUTTON, "Apply change") Then Exit 33
If Not __WaitFor(${autoItString(paths.applied)}) Then Exit 34
If Not SandiUIA_Toggle($hTarget, $iPid, "5", $SANDI_UIA_CHECKBOX, "Enable feature") Then Exit 36
If Not __WaitFor(${autoItString(paths.toggled)}) Then Exit 37
If Not SandiUIA_Select($hTarget, $iPid, "", $SANDI_UIA_LISTITEM, "Ada Lovelace") Then Exit 38
If Not __WaitFor(${autoItString(paths.selected)}) Then Exit 39

Local $oDuplicate = SandiUIA_Find($hTarget, $iPid, "", $SANDI_UIA_BUTTON, "Duplicate")
Local $iDuplicateError = @error
If $oDuplicate Then Exit 40
If $iDuplicateError <> $SANDI_UIA_ERROR_AMBIGUOUS Then Exit 41
Local $oWrongPid = SandiUIA_Find($hTarget, $iPid + 1, "", $SANDI_UIA_EDIT, "")
Local $iWrongPidError = @error
If $oWrongPid Then Exit 42
If $iWrongPidError <> $SANDI_UIA_ERROR_ROOT Then Exit 43
Local $oStaleWindow = SandiUIA_Find(HWnd(1), $iPid, "", $SANDI_UIA_EDIT, "")
Local $iStaleWindowError = @error
If $oStaleWindow Then Exit 44
If $iStaleWindowError <> $SANDI_UIA_ERROR_ROOT Then Exit 45
WinActivate($hTarget)
If Not WinWaitActive($hTarget, "", 3) Then Exit 46
If Not ControlFocus($hTarget, "", "Edit1") Then Exit 47
If Not __SandiUIA_FocusedMatches($hTarget, $iPid, "3", $SANDI_UIA_EDIT, "") Then Exit 48
If Not ControlFocus($hTarget, "", "Button1") Then Exit 49
If __SandiUIA_FocusedMatches($hTarget, $iPid, "3", $SANDI_UIA_EDIT, "") Then Exit 50

ConsoleWrite("uia=ok" & @CRLF)
Exit 0

Func __WaitFor($sPath)
    Local $hTimer = TimerInit()
    While TimerDiff($hTimer) < 3000
        If FileExists($sPath) Then Return True
        Sleep(10)
    WEnd
    Return False
EndFunc
`;
}

async function waitUntil(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${label()}`);
}

function autoItString(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
