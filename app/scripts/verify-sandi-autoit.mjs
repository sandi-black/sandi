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

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("SandiAutoIt verification requires Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const runtime = join(appRoot, "build", "mcp", "autoit", "AutoIt3_x64.exe");
const root = mkdtempSync(join(tmpdir(), "sandi-autoit-uia-"));
const ready = join(root, "fixture.ready");
const applied = join(root, "applied.txt");
const toggled = join(root, "toggled.txt");
const selected = join(root, "selected.txt");
const inspection = join(root, "inspection.json");
const inspectionRepeat = join(root, "inspection-repeat.json");
const limitedInspection = join(root, "inspection-limited.json");
const remove = join(root, "remove-temp");
const removed = join(root, "temp-removed");
const fixturePath = join(root, "fixture.au3");
const inspectionDriverPath = join(root, "inspection-driver.au3");
const driverPath = join(root, "driver.au3");
let fixture;

try {
  await verifyElectronEditor(runtime, root, electronExecutable);
  verifyNotepad(runtime, root);
  writeFileSync(
    fixturePath,
    autoItFixture({ ready, applied, toggled, selected, remove, removed }),
  );
  writeFileSync(
    inspectionDriverPath,
    autoItInspectionDriver({
      ready,
      inspection,
      inspectionRepeat,
      limitedInspection,
    }),
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

  const inspectionRun = spawnSync(
    runtime,
    ["/ErrorStdOut", inspectionDriverPath],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(
    inspectionRun.status,
    0,
    inspectionRun.stderr || inspectionRun.stdout,
  );
  assert.equal(inspectionRun.stdout.trim(), "inspection=ok");
  const inspected = JSON.parse(readFileSync(inspection, "utf8"));
  assert.deepEqual(
    inspected,
    JSON.parse(readFileSync(inspectionRepeat, "utf8")),
  );
  assert.equal(inspected.root.pid > 0, true);
  assert.equal(inspected.root.hwnd > 0, true);
  assert.deepEqual(inspected.filters, {
    automationId: "",
    controlType: 0,
    name: "",
    className: "",
  });
  assert.deepEqual(inspected.limits, { nodes: 64, results: 32 });
  assert.equal(inspected.includeDocumentChildren, false);
  assert.equal(inspected.truncated, false);
  assert.deepEqual(inspected.truncation, { nodes: false, results: false });
  assert.equal(inspected.returned, inspected.elements.length);
  assert.equal(inspected.matched, inspected.elements.length);
  assert.equal(inspected.visited >= inspected.returned, true);
  for (const element of inspected.elements) {
    assert.deepEqual(Object.keys(element.identity), [
      "automationId",
      "controlType",
      "name",
      "className",
      "path",
    ]);
    assert.equal(typeof element.automationId, "string");
    assert.equal(typeof element.controlType, "number");
    assert.equal(typeof element.controlTypeName, "string");
    assert.equal(typeof element.name, "string");
    assert.equal(typeof element.className, "string");
    assert.equal(typeof element.nativeHwnd, "number");
    assert.equal(Array.isArray(element.patterns), true);
    assert.equal(Array.isArray(element.actions), true);
    assert.equal(element.actions.includes("Describe"), true);
  }
  const edit = findElement(
    inspected,
    (element) => element.automationId === "3",
  );
  assert.equal(edit.controlType, 50004);
  assert.equal(edit.patterns.includes("Value"), true);
  assert.equal(edit.actions.includes("GetValue"), true);
  assert.equal(edit.actions.includes("SetValue"), true);
  assert.equal(
    findElement(
      inspected,
      (element) => element.automationId === "4",
    ).actions.includes("Invoke"),
    true,
  );
  assert.equal(
    findElement(
      inspected,
      (element) => element.automationId === "5",
    ).actions.includes("Toggle"),
    true,
  );
  assert.equal(
    findElement(
      inspected,
      (element) =>
        element.controlType === 50007 && element.name === "Ada Lovelace",
    ).actions.includes("Select"),
    true,
  );
  const limited = JSON.parse(readFileSync(limitedInspection, "utf8"));
  assert.equal(limited.returned, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.truncation.results, true);
  assert.equal(limited.elements.length, 2);

  const identityDriverPath = join(root, "identity-driver.au3");
  writeFileSync(
    identityDriverPath,
    autoItIdentityDriver(
      { ready, applied, toggled, selected },
      inspected.elements,
    ),
  );
  const identityResult = spawnSync(
    runtime,
    ["/ErrorStdOut", identityDriverPath],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(
    identityResult.status,
    0,
    identityResult.stderr || identityResult.stdout,
  );
  assert.equal(identityResult.stdout.trim(), "identities=ok");
  for (const path of [applied, toggled, selected]) {
    rmSync(path, { force: true });
  }
  const result = spawnSync(runtime, ["/ErrorStdOut", driverPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "uia=ok");
  assert.equal(readFileSync(applied, "utf8"), "Grace Hopper");
  assert.equal(readFileSync(toggled, "utf8"), "1");
  assert.equal(readFileSync(selected, "utf8"), "Ada Lovelace");
  assert.match(result.stderr, /ambiguous selector/);
  assert.match(result.stderr, /automationId="7"/);
  assert.match(result.stderr, /automationId="8"/);
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

function autoItInspectionDriver(paths) {
  return `#include <SandiAutoIt.au3>

Local $aFixture = StringSplit(StringStripWS(FileRead(${autoItString(paths.ready)}), 3), "|", 2)
If UBound($aFixture) <> 3 Then Exit 10
Local $hTarget = HWnd(Number($aFixture[0]))
Local $iPid = Number($aFixture[2])
Local $sInspection = SandiUIA_Inspect($hTarget, $iPid)
If @error Or $sInspection = "" Then Exit 51
FileWrite(${autoItString(paths.inspection)}, $sInspection)
Local $sInspectionRepeat = SandiUIA_Inspect($hTarget, $iPid)
If @error Or $sInspectionRepeat <> $sInspection Then Exit 52
FileWrite(${autoItString(paths.inspectionRepeat)}, $sInspectionRepeat)
Local $sLimitedInspection = SandiUIA_Inspect($hTarget, $iPid, "", 0, "", "", False, 64, 2)
If @error Or $sLimitedInspection = "" Then Exit 53
FileWrite(${autoItString(paths.limitedInspection)}, $sLimitedInspection)
Local $sFilteredInspection = SandiUIA_Inspect($hTarget, $iPid, "3", $SANDI_UIA_EDIT)
If @error Or Not StringInStr($sFilteredInspection, '"returned":1') Then Exit 54
Local $sWrongPidInspection = SandiUIA_Inspect($hTarget, $iPid + 1)
If $sWrongPidInspection <> "" Or @error <> $SANDI_UIA_ERROR_ROOT Then Exit 55
Local $sStaleInspection = SandiUIA_Inspect(HWnd(1), $iPid)
If $sStaleInspection <> "" Or @error <> $SANDI_UIA_ERROR_ROOT Then Exit 57
Local $sBadLimitInspection = SandiUIA_Inspect($hTarget, $iPid, "", 0, "", "", False, 0, 2)
If $sBadLimitInspection <> "" Or @error <> $SANDI_UIA_ERROR_SELECTOR Then Exit 56
ConsoleWrite("inspection=ok" & @CRLF)
`;
}

function autoItIdentityDriver(paths, elements) {
  const describes = elements
    .map((element, index) => {
      const args = identityArguments(element.identity);
      return `If SandiUIA_Describe($hTarget, $iPid, ${args}) = "" Then Exit ${60 + index}`;
    })
    .join("\n");
  const edit = findElement(elements, (element) => element.automationId === "3");
  const apply = findElement(
    elements,
    (element) => element.automationId === "4",
  );
  const toggle = findElement(
    elements,
    (element) => element.automationId === "5",
  );
  const listItem = findElement(
    elements,
    (element) =>
      element.controlType === 50007 && element.name === "Ada Lovelace",
  );
  return `#include <SandiAutoIt.au3>

Local $aFixture = StringSplit(StringStripWS(FileRead(${autoItString(paths.ready)}), 3), "|", 2)
If UBound($aFixture) <> 3 Then Exit 10
Local $hTarget = HWnd(Number($aFixture[0]))
Local $iPid = Number($aFixture[2])
${describes}
If Not SandiUIA_SetValue($hTarget, $iPid, ${setValueIdentityArguments(edit.identity, "Grace Hopper")}) Then Exit 81
If SandiUIA_GetValue($hTarget, $iPid, ${identityArguments(edit.identity)}) <> "Grace Hopper" Then Exit 80
If Not SandiUIA_Invoke($hTarget, $iPid, ${identityArguments(apply.identity)}) Then Exit 82
If Not SandiUIA_Toggle($hTarget, $iPid, ${identityArguments(toggle.identity)}) Then Exit 83
Sleep(100)
If Not SandiUIA_Toggle($hTarget, $iPid, ${identityArguments(toggle.identity)}) Then Exit 85
If Not SandiUIA_Select($hTarget, $iPid, ${identityArguments(listItem.identity)}) Then Exit 84
Sleep(100)
ConsoleWrite("identities=ok" & @CRLF)
`;
}

function verifyNotepad(autoItRuntime, fixtureRoot) {
  const script = join(fixtureRoot, "notepad-inspector.au3");
  writeFileSync(script, autoItNotepadInspector());
  const result = spawnSync(autoItRuntime, ["/ErrorStdOut", script], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const defaultInspection = JSON.parse(lines[0]);
  const includedInspection = JSON.parse(lines[1]);
  assert.equal(defaultInspection.includeDocumentChildren, false);
  assert.equal(
    defaultInspection.documentSubtreesSkipped,
    1,
    JSON.stringify(defaultInspection),
  );
  assert.equal(defaultInspection.elements.length, 1);
  assert.equal(defaultInspection.elements[0].controlType, 50030);
  assert.equal(defaultInspection.elements[0].controlTypeName, "Document");
  assert.equal(defaultInspection.elements[0].name, "Text editor");
  assert.equal(
    defaultInspection.elements[0].actions.includes("Describe"),
    true,
  );
  assert.equal(includedInspection.includeDocumentChildren, true);
  assert.equal(includedInspection.documentSubtreesSkipped, 0);
  assert.equal(includedInspection.visited >= defaultInspection.visited, true);
}

async function verifyElectronEditor(autoItRuntime, fixtureRoot, electron) {
  const fixtureMain = join(fixtureRoot, "electron-editor.cjs");
  const fixtureHtml = join(fixtureRoot, "electron-editor.html");
  const readyPath = join(fixtureRoot, "electron-editor.ready");
  const statePath = join(fixtureRoot, "electron-editor-state.json");
  const clipboardSnapshotPath = join(
    fixtureRoot,
    "electron-editor-clipboard.json",
  );
  const commandPath = join(fixtureRoot, "electron-editor-command.json");
  const inspectionPath = join(fixtureRoot, "electron-editor-inspection.au3");
  writeFileSync(fixtureHtml, electronEditorHtml({ statePath, commandPath }));
  writeFileSync(fixtureMain, electronEditorMain({ fixtureHtml, readyPath }));
  const fixture = spawn(electron, [fixtureMain], {
    cwd: fixtureRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let fixtureError = "";
  fixture.stderr.setEncoding("utf8");
  fixture.stderr.on("data", (chunk) => {
    fixtureError += chunk;
  });
  try {
    await waitUntil(
      () => existsSync(readyPath) && existsSync(statePath),
      () => `Electron editor readiness; stderr=${fixtureError}`,
    );
    writeFileSync(inspectionPath, electronInspectionDriver(readyPath));
    const inspection = spawnSync(
      autoItRuntime,
      ["/ErrorStdOut", inspectionPath],
      { cwd: fixtureRoot, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(inspection.status, 0, inspection.stderr || inspection.stdout);
    const inspected = JSON.parse(inspection.stdout.trim());
    const composer = inspected.elements.find(
      (element) => element.name === "Sandi composer",
    );
    assert.notEqual(composer, undefined, JSON.stringify(inspected));
    const submit = findElement(
      inspected,
      (element) => element.name === "Submit draft",
    );
    assert.equal(composer.patterns.includes("Text"), true);
    assert.equal(composer.actions.includes("SetValue"), false);
    assert.equal(composer.actions.includes("InsertText"), true);
    const driverPath = join(fixtureRoot, "electron-editor-driver.au3");
    writeFileSync(
      driverPath,
      electronInsertionDriver({
        readyPath,
        statePath,
        clipboardSnapshotPath,
        commandPath,
        composer: composer.identity,
        submit: submit.identity,
      }),
    );
    const insertion = spawnSync(autoItRuntime, ["/ErrorStdOut", driverPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(insertion.status, 0, insertion.stderr || insertion.stdout);
    assert.equal(insertion.stdout.trim(), "electron-editor=ok");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const clipboardSnapshot = JSON.parse(
      readFileSync(clipboardSnapshotPath, "utf8"),
    );
    assert.equal(clipboardSnapshot.clipboardText, "Grace clipboard");
    assert.match(clipboardSnapshot.clipboardHtml, /<b>Grace clipboard<\/b>/);
    assert.equal(
      clipboardSnapshot.clipboardFormats.includes("text/html"),
      true,
    );
    assert.equal(state.draft.replaceAll("\r\n", "\n"), "Ada\nGrace\nHopper");
    assert.equal(state.decoy, "");
    assert.equal(state.submissions, 1);
    console.log("SandiAutoIt Electron editor insertion verification passed");
  } finally {
    if (fixture.pid !== undefined) {
      spawnSync("taskkill.exe", ["/pid", String(fixture.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      await waitUntil(
        () => fixture.exitCode !== null,
        () => "Electron editor termination",
      );
    }
  }
}

function electronEditorMain(paths) {
  return `const { app, BrowserWindow, Menu } = require("electron");
const { writeFileSync } = require("node:fs");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  await window.loadFile(${JSON.stringify(paths.fixtureHtml)});
  window.show();
  window.focus();
  await window.webContents.executeJavaScript('document.getElementById("composer").focus()');
  const handle = window.getNativeWindowHandle();
  writeFileSync(${JSON.stringify(paths.readyPath)}, String(handle.readBigUInt64LE()) + "|" + String(process.pid));
});
app.on("window-all-closed", () => app.quit());
`;
}

function electronEditorHtml(paths) {
  const state = JSON.stringify(paths.statePath);
  const command = JSON.stringify(paths.commandPath);
  return `<!doctype html>
<html><body>
  <main>
    <div id="composer" role="document" aria-label="Sandi composer" contenteditable="true"></div>
    <button id="submit" aria-label="Submit draft">Submit</button>
    <input id="decoy" aria-label="Decoy editor" />
  </main>
  <style>
    body { font-family: sans-serif; }
    #composer { border: 1px solid #777; min-height: 160px; white-space: pre-wrap; }
  </style>
  <script>
    const fs = require("node:fs");
    const { clipboard } = require("electron");
    const statePath = ${state};
    const commandPath = ${command};
    const composer = document.getElementById("composer");
    const submit = document.getElementById("submit");
    const decoy = document.getElementById("decoy");
    let submissions = 0;
    let command = "";
    const persist = () => fs.writeFileSync(statePath, JSON.stringify({
      draft: composer.innerText,
      decoy: decoy.value,
      submissions,
      focus: document.activeElement?.id ?? "",
      clipboardText: clipboard.readText(),
      clipboardHtml: clipboard.readHTML(),
      clipboardFormats: clipboard.availableFormats(),
      command,
    }));
    composer.addEventListener("input", persist);
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submissions += 1;
        persist();
      }
    });
    submit.addEventListener("click", () => { submissions += 1; persist(); });
    for (const element of [composer, submit, decoy]) element.addEventListener("focus", persist);
    setInterval(() => {
      if (!fs.existsSync(commandPath)) return;
      const next = JSON.parse(fs.readFileSync(commandPath, "utf8"));
      fs.unlinkSync(commandPath);
      command = next.action;
      if (next.action === "clear") {
        composer.innerHTML = "";
        decoy.value = "";
        submissions = 0;
        composer.focus();
      } else if (next.action === "seed") {
        composer.innerHTML = "";
        decoy.value = "";
        submissions = 0;
        clipboard.write({ text: "Grace clipboard", html: "<b>Grace clipboard</b>" });
        composer.focus();
      } else if (next.action === "snapshot") {
        persist();
      } else if (next.action === "steal") {
        composer.addEventListener("paste", (event) => {
          event.preventDefault();
          decoy.focus();
          persist();
        }, { once: true });
        composer.focus();
      } else {
        document.getElementById(next.action)?.focus();
      }
      persist();
    }, 10);
    persist();
  </script>
</body></html>`;
}

function electronInspectionDriver(readyPath) {
  return `#include <SandiAutoIt.au3>
Local $parts = StringSplit(StringStripWS(FileRead(${autoItString(readyPath)}), 3), "|", 2)
If UBound($parts) <> 2 Then Exit 10
Local $hWnd = HWnd(Number($parts[0]))
Local $iPid = Number($parts[1])
Local $inspection = SandiUIA_Inspect($hWnd, $iPid, "", 0, "", "", True, 128, 64)
If @error Or $inspection = "" Then Exit 11
ConsoleWrite($inspection & @CRLF)
`;
}

function electronInsertionDriver(input) {
  const composer = editorInsertArguments(
    input.composer,
    '"Ada" & @CR & "Grace" & @LF & "Hopper"',
  );
  const composerTooLarge = editorInsertArguments(
    input.composer,
    '_StringRepeat("x", 65537)',
  );
  const composerRedirected = editorInsertArguments(
    input.composer,
    '"redirected"',
  );
  const submit = identityArguments(input.submit);
  const submitInsert = editorInsertArguments(input.submit, '"unsupported"');
  return `#include <String.au3>
#include <SandiAutoIt.au3>
Local $parts = StringSplit(StringStripWS(FileRead(${autoItString(input.readyPath)}), 3), "|", 2)
If UBound($parts) <> 2 Then Exit 10
Local $hWnd = HWnd(Number($parts[0]))
Local $iPid = Number($parts[1])
WinActivate($hWnd)
If Not WinWaitActive($hWnd, "", 3) Then Exit 11
If Not __Command("seed", '"focus":"composer"') Then Exit 12
Local $inserted = SandiEditor_InsertText($hWnd, $iPid, ${composer})
Local $insertError = @error
Local $insertExtended = @extended
If Not $inserted Then
    ConsoleWriteError("insertError=" & $insertError & "; extended=" & $insertExtended & @CRLF)
    Exit 20
EndIf
If ClipGet() <> "Grace clipboard" Then Exit 21
If Not __Command("snapshot", '"focus":"composer"') Then Exit 26
If Not FileCopy(${autoItString(input.statePath)}, ${autoItString(input.clipboardSnapshotPath)}, 1) Then Exit 27
Sleep(100)
Local $beforeBounds = FileRead(${autoItString(input.statePath)})
Local $tooLarge = SandiEditor_InsertText($hWnd, $iPid, ${composerTooLarge})
If $tooLarge Or @error <> $SANDI_EDITOR_ERROR_PAYLOAD Then Exit 22
If FileRead(${autoItString(input.statePath)}) <> $beforeBounds Then Exit 23
Local $unsafeType = SandiInput_TypeText($hWnd, $iPid, ${autoItString(input.composer.automationId)}, ${input.composer.controlType}, ${autoItString(input.composer.name)}, "unsafe" & @LF & "submit")
If $unsafeType Or @error <> $SANDI_INPUT_ERROR_ARGUMENT Then Exit 24
If Not StringInStr(FileRead(${autoItString(input.statePath)}), '"submissions":0') Then Exit 25
If Not __Command("steal", '"focus":"composer"') Then Exit 30
ClipPut("Grace focus clipboard")
Local $lostFocus = SandiEditor_InsertText($hWnd, $iPid, ${composerRedirected})
Local $lostError = @error
If $lostFocus Or $lostError <> $SANDI_EDITOR_ERROR_TARGET Then
    ConsoleWriteError("lostFocus=" & $lostFocus & "; error=" & $lostError & @CRLF)
    Exit 31
EndIf
If Not StringInStr(FileRead(${autoItString(input.statePath)}), '"decoy":""') Then Exit 32
If ClipGet() <> "Grace focus clipboard" Then Exit 33
If Not __Command("submit", '"focus":"submit"') Then Exit 40
Local $unsupported = SandiEditor_InsertText($hWnd, $iPid, ${submitInsert})
If $unsupported Or @error <> $SANDI_EDITOR_ERROR_UNSUPPORTED Then Exit 41
If Not __Command("composer", '"focus":"composer"') Then Exit 42
If Not SandiUIA_Invoke($hWnd, $iPid, ${submit}) Then Exit 43
Local $timer = TimerInit()
While TimerDiff($timer) < 3000 And Not StringInStr(FileRead(${autoItString(input.statePath)}), '"submissions":1')
    Sleep(10)
WEnd
If Not StringInStr(FileRead(${autoItString(input.statePath)}), '"submissions":1') Then Exit 44
ConsoleWrite("electron-editor=ok" & @CRLF)

Func __Command($action, $expected)
    FileDelete(${autoItString(input.commandPath)})
    If Not FileWrite(${autoItString(input.commandPath)}, '{"action":"' & $action & '"}') Then Return False
    Local $timer = TimerInit()
    While TimerDiff($timer) < 3000
        Local $state = FileRead(${autoItString(input.statePath)})
        If StringInStr($state, $expected) And StringInStr($state, '"command":"' & $action & '"') Then Return True
        Sleep(10)
    WEnd
    Return False
EndFunc
`;
}

function autoItNotepadInspector() {
  return `#include <SandiAutoIt.au3>

Local $aBefore = WinList("[REGEXPTITLE:(?i)notepad]")
Local $iLaunchPid = Run('"' & @WindowsDir & '\\System32\\notepad.exe"')
If $iLaunchPid = 0 Then Exit 10
Local $hWnd = 0
Local $iPid = 0
Local $sDefault = ""
Local $hTimer = TimerInit()
While TimerDiff($hTimer) < 10000 And Not StringInStr($sDefault, '"returned":1')
    Local $aWindows = WinList("[REGEXPTITLE:(?i)notepad]")
    For $iIndex = 1 To $aWindows[0][0]
        If BitAND(WinGetState($aWindows[$iIndex][1]), 2) And _
                Not __WasPresent($aWindows[$iIndex][1], $aBefore) Then
            $hWnd = $aWindows[$iIndex][1]
            $iPid = WinGetProcess($hWnd)
            If $iPid > 0 Then _
                    $sDefault = SandiUIA_Inspect($hWnd, $iPid, "", $SANDI_UIA_DOCUMENT, "Text editor")
            If Not @error And StringInStr($sDefault, '"returned":1') Then ExitLoop
        EndIf
    Next
    If Not StringInStr($sDefault, '"returned":1') Then Sleep(50)
WEnd
If $hWnd = 0 Then __Finish($hWnd, $iLaunchPid, 11)
If $iPid = 0 Then __Finish($hWnd, $iLaunchPid, 14)
If Not StringInStr($sDefault, '"returned":1') Then
    ConsoleWriteError(SandiUIA_Inspect($hWnd, $iPid, "", 0, "", "", False, 64, 128) & @CRLF)
    __Finish($hWnd, $iLaunchPid, 12)
EndIf
Local $sIncluded = SandiUIA_Inspect($hWnd, $iPid, "", $SANDI_UIA_DOCUMENT, "Text editor", "", True)
If @error Or $sIncluded = "" Then __Finish($hWnd, $iLaunchPid, 13)
ConsoleWrite($sDefault & @CRLF & $sIncluded & @CRLF)
__Finish($hWnd, $iLaunchPid, 0)

Func __WasPresent($hWnd, ByRef $aWindows)
    For $iIndex = 1 To $aWindows[0][0]
        If $aWindows[$iIndex][1] = $hWnd Then Return True
    Next
    Return False
EndFunc

Func __Finish($hWnd, $iLaunchPid, $iExitCode)
    If $hWnd <> 0 Then
        WinClose($hWnd)
        WinWaitClose($hWnd, "", 3)
    EndIf
    If ProcessExists($iLaunchPid) Then
        ProcessClose($iLaunchPid)
        ProcessWaitClose($iLaunchPid, 5)
    EndIf
    Exit $iExitCode
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

function identityArguments(identity) {
  return [
    identity.automationId,
    identity.controlType,
    identity.name,
    identity.className,
    identity.path,
  ]
    .map((value) =>
      typeof value === "number" ? String(value) : autoItString(value),
    )
    .join(", ");
}

function setValueIdentityArguments(identity, value) {
  return [
    identity.automationId,
    identity.controlType,
    identity.name,
    value,
    identity.className,
    identity.path,
  ]
    .map((item) =>
      typeof item === "number" ? String(item) : autoItString(item),
    )
    .join(", ");
}

function editorInsertArguments(identity, valueExpression) {
  return [
    autoItString(identity.automationId),
    String(identity.controlType),
    autoItString(identity.name),
    valueExpression,
    autoItString(identity.className),
    autoItString(identity.path),
  ].join(", ");
}

function findElement(collection, predicate) {
  const element = Array.isArray(collection)
    ? collection.find(predicate)
    : collection.elements.find(predicate);
  assert.notEqual(element, undefined);
  return element;
}
