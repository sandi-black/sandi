import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export async function verify(bundle, root) {
  const autoit = join(bundle, "autoit", "AutoIt3_x64.exe");
  await verifyPathChurnFixture(autoit, root);
  await verifyNotepad(autoit, root);
}

async function verifyNotepad(autoit, root) {
  if (hasRunningNotepad()) {
    console.log("skipped Notepad UIA smoke because Notepad is already running");
    return;
  }
  const filePath = join(
    root,
    `sandi-notepad-smoke-${process.pid}-${Date.now()}.txt`,
  );
  writeFileSync(filePath, "original");
  const notepad = spawn("notepad.exe", [filePath], {
    cwd: root,
    windowsHide: false,
    stdio: "ignore",
  });
  let ownedPid = notepad.pid;

  try {
    assert(notepad.pid, "Notepad did not start");
    const output = runAutoIt(autoit, root, "discover-notepad", [
      `Local $sTitleNeedle = ${autoItString(basename(filePath))}`,
      "Local $hTimer = TimerInit()",
      "While TimerDiff($hTimer) < 10000",
      "    Local $aWindows = WinList()",
      "    For $iIndex = 1 To $aWindows[0][0]",
      "        Local $hCandidate = HWnd($aWindows[$iIndex][1])",
      "        If $hCandidate <> 0 And BitAND(WinGetState($hCandidate), 2) And _",
      "                StringInStr($aWindows[$iIndex][0], $sTitleNeedle) Then",
      '            ConsoleWrite(Number($hCandidate) & "|" & WinGetProcess($hCandidate))',
      "            Exit 0",
      "        EndIf",
      "    Next",
      "    Sleep(25)",
      "WEnd",
      "Exit 30",
    ]);
    const [hwndText, pidText] = output.split("|");
    assert(hwndText && pidText, "Notepad discovery returned invalid identity");
    const window = { hwnd: hwndText, pid: Number(pidText) };
    ownedPid = window.pid;

    const inspection = inspect(autoit, root, window, "inspect-notepad");
    const editor = inspection.elements.find(
      (element) =>
        element.identity.controlType === 50030 &&
        element.identity.name === "Text editor",
    );
    assert(
      editor,
      `Notepad did not expose its Text editor control: ${JSON.stringify(
        inspection.elements.map((element) => element.identity),
      )}`,
    );
    assert.equal(
      getValue(autoit, root, window, editor.identity, "notepad-get-before"),
      "original",
    );
    setValue(autoit, root, window, editor.identity, "changed", "notepad-set");
    assert.equal(
      getValue(autoit, root, window, editor.identity, "notepad-get-after"),
      "changed",
    );
    setValue(
      autoit,
      root,
      window,
      editor.identity,
      "original",
      "notepad-restore",
    );
    assert.equal(
      getValue(autoit, root, window, editor.identity, "notepad-get-restored"),
      "original",
    );
    assert.equal(readFileSync(filePath, "utf8"), "original");
  } finally {
    if (notepad.exitCode === null) notepad.kill();
    await waitForExit(notepad, 2_000);
    if (ownedPid && isNotepadProcess(ownedPid)) {
      spawnSync("taskkill.exe", ["/pid", String(ownedPid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  }
}

function hasRunningNotepad() {
  const result = spawnSync(
    "tasklist.exe",
    ["/fi", "imagename eq notepad.exe", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.toLowerCase().includes('"notepad.exe"');
}

function isNotepadProcess(pid) {
  const result = spawnSync(
    "tasklist.exe",
    ["/fi", `pid eq ${pid}`, "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.toLowerCase().includes('"notepad.exe"');
}

async function verifyPathChurnFixture(autoit, root) {
  const statePath = join(root, "uia-fixture-state.txt");
  const commandPath = join(root, "uia-fixture-command.txt");
  const ackPath = join(root, "uia-fixture-ack.txt");
  const fixturePath = join(root, "uia-retained-fixture.au3");
  writeFileSync(
    fixturePath,
    [
      "#include <GUIConstantsEx.au3>",
      "#include <WindowsConstants.au3>",
      'Opt("MustDeclareVars", 1)',
      `Local $sStatePath = ${autoItString(statePath)}`,
      `Local $sCommandPath = ${autoItString(commandPath)}`,
      `Local $sAckPath = ${autoItString(ackPath)}`,
      'Local $hGui = GUICreate("Sandi retained UIA fixture", 420, 180)',
      'Local $idLeading = GUICtrlCreateButton("Unrelated sibling", 12, 12, 160, 30)',
      'Local $idTarget = GUICtrlCreateInput("original", 12, 58, 300, 28)',
      'Local $idTrailing = GUICtrlCreateButton("Trailing sibling", 12, 102, 160, 30)',
      'Local $idMenu = GUICtrlCreateMenu("Fixture")',
      'Local $idZero = GUICtrlCreateMenuItem("Unique zero target", $idMenu)',
      "Local $idDuplicate = 0",
      "GUISetState(@SW_SHOW, $hGui)",
      'FileWrite($sStatePath, Number($hGui) & "|" & @AutoItPID & "|" & Number(GUICtrlGetHandle($idTarget)))',
      "While True",
      "    Local $iMessage = GUIGetMsg()",
      "    If $iMessage = $GUI_EVENT_CLOSE Then ExitLoop",
      "    If FileExists($sCommandPath) Then",
      "        Local $sCommand = StringStripWS(FileRead($sCommandPath), 3)",
      "        FileDelete($sCommandPath)",
      "        Switch $sCommand",
      '            Case "remove-leading"',
      "                GUICtrlDelete($idLeading)",
      '                FileWrite($sAckPath, "removed")',
      '            Case "duplicate-zero"',
      '                $idDuplicate = GUICtrlCreateMenu("Fixture")',
      '                FileWrite($sAckPath, "duplicated")',
      '            Case "stop"',
      "                ExitLoop",
      "        EndSwitch",
      "    EndIf",
      "    Sleep(10)",
      "WEnd",
      "GUIDelete($hGui)",
      "",
    ].join("\r\n"),
  );

  const fixture = spawn(autoit, ["/ErrorStdOut", fixturePath], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let fixtureOutput = "";
  fixture.stdout.setEncoding("utf8");
  fixture.stderr.setEncoding("utf8");
  fixture.stdout.on("data", (chunk) => {
    fixtureOutput += chunk;
  });
  fixture.stderr.on("data", (chunk) => {
    fixtureOutput += chunk;
  });

  try {
    await waitForFile(statePath, "UIA fixture state");
    const [hwndText, pidText, nativeHwndText] = readFileSync(
      statePath,
      "utf8",
    ).split("|");
    assert(
      hwndText && pidText && nativeHwndText,
      "UIA fixture state is invalid",
    );
    const window = { hwnd: hwndText, pid: Number(pidText) };
    const nativeHwnd = Number(nativeHwndText);

    const before = inspect(autoit, root, window, "fixture-before");
    const target = before.elements.find(
      (element) => element.identity.nativeHwnd === nativeHwnd,
    );
    assert(target, "UIA fixture edit was not inspected");
    assert.equal(
      getValue(autoit, root, window, target.identity, "stable-path"),
      "original",
    );

    await commandFixture(commandPath, ackPath, "remove-leading", "removed");
    const after = inspect(autoit, root, window, "fixture-after");
    const movedTarget = after.elements.find(
      (element) => element.identity.nativeHwnd === nativeHwnd,
    );
    assert(movedTarget, "UIA fixture edit disappeared after sibling removal");
    assert.notEqual(
      movedTarget.identity.path,
      target.identity.path,
      "removing a leading sibling must change the retained path",
    );
    assert.equal(
      getValue(autoit, root, window, target.identity, "churned-path"),
      "original",
    );
    setValue(
      autoit,
      root,
      window,
      target.identity,
      "changed",
      "set-after-churn",
    );
    assert.equal(
      getValue(autoit, root, window, target.identity, "verify-after-churn"),
      "changed",
    );

    const mismatchedIdentity = {
      ...target.identity,
      nativeHwnd: target.identity.nativeHwnd + 1,
    };
    assert.equal(
      setValueError(
        autoit,
        root,
        window,
        mismatchedIdentity,
        "must-not-apply",
        "native-hwnd-mismatch",
      ),
      4,
      "a native HWND mismatch must fail as no match",
    );
    assert.equal(
      getValue(autoit, root, window, target.identity, "verify-mismatch"),
      "changed",
      "a mismatched identity must not mutate the target",
    );
    assert.equal(
      setValueError(
        autoit,
        root,
        window,
        { ...target.identity, name: "Changed identity" },
        "must-not-apply",
        "semantic-mismatch",
      ),
      4,
      "changed semantic identity must fail as no match",
    );
    assert.equal(
      setValueError(
        autoit,
        root,
        { ...window, pid: window.pid + 1 },
        target.identity,
        "must-not-apply",
        "pid-mismatch",
      ),
      2,
      "a PID mismatch must fail at the retained root",
    );
    assert.equal(
      setValueError(
        autoit,
        root,
        { ...window, hwnd: "1" },
        target.identity,
        "must-not-apply",
        "stale-hwnd",
      ),
      2,
      "a stale HWND must fail at the retained root",
    );
    assert.equal(
      getValue(autoit, root, window, target.identity, "verify-refusals"),
      "changed",
      "stale and changed identities must not mutate the target",
    );

    const zeroTarget = after.elements.find(
      (element) =>
        element.identity.nativeHwnd === 0 &&
        element.identity.controlType === 50011 &&
        element.identity.name === "Fixture",
    );
    assert(
      zeroTarget,
      `UIA fixture did not expose the zero-HWND menu item: ${JSON.stringify(
        after.elements.filter((element) => element.identity.nativeHwnd === 0),
      )}`,
    );
    assert.match(
      describe(autoit, root, window, {
        ...zeroTarget.identity,
        path: "255",
      }),
      /name="Fixture"/,
      "a unique zero-HWND identity must survive path churn",
    );

    await commandFixture(commandPath, ackPath, "duplicate-zero", "duplicated");
    assert.equal(
      describeError(autoit, root, window, {
        ...zeroTarget.identity,
        path: "255",
      }),
      5,
      "duplicate semantic matches must fail as ambiguous",
    );
  } finally {
    writeFileSync(commandPath, "stop");
    const exitCode = await waitForExit(fixture, 5_000);
    if (exitCode === null) fixture.kill();
    rmSync(commandPath, { force: true });
    rmSync(ackPath, { force: true });
    assert.equal(exitCode, 0, fixtureOutput);
  }
}

function inspect(autoit, root, window, label) {
  const output = runAutoIt(autoit, root, label, [
    "#include <SandiAutoIt.au3>",
    `Local $sResult = SandiUIA_Inspect(HWnd(${autoItString(window.hwnd)}), ${window.pid}, "", 0, "", "", True, 256, 128)`,
    "If @error Then Exit 20",
    "ConsoleWrite($sResult)",
  ]);
  return JSON.parse(output);
}

function getValue(autoit, root, window, identity, label) {
  return runAutoIt(autoit, root, label, [
    "#include <SandiAutoIt.au3>",
    `Local $sValue = SandiUIA_GetValue(${identityArgs(window, identity)})`,
    "If @error Then Exit 21",
    "ConsoleWrite($sValue)",
  ]);
}

function setValue(autoit, root, window, identity, value, label) {
  runAutoIt(autoit, root, label, [
    "#include <SandiAutoIt.au3>",
    `Local $bChanged = SandiUIA_SetValue(${identityValueArgs(window, identity, value)})`,
    "If @error Or Not $bChanged Then Exit 22",
    `Local $sActual = SandiUIA_GetValue(${identityArgs(window, identity)})`,
    `If @error Or $sActual <> ${autoItString(value)} Then Exit 24`,
  ]);
}

function setValueError(autoit, root, window, identity, value, label) {
  return Number(
    runAutoIt(autoit, root, label, [
      "#include <SandiAutoIt.au3>",
      `Local $bChanged = SandiUIA_SetValue(${identityValueArgs(window, identity, value)})`,
      "Local $iError = @error",
      "ConsoleWrite($iError)",
    ]),
  );
}

function describe(autoit, root, window, identity) {
  return runAutoIt(autoit, root, "describe-zero-hwnd", [
    "#include <SandiAutoIt.au3>",
    `Local $sDescription = SandiUIA_Describe(${identityArgs(window, identity)})`,
    "If @error Then Exit 23",
    "ConsoleWrite($sDescription)",
  ]);
}

function describeError(autoit, root, window, identity) {
  return Number(
    runAutoIt(autoit, root, "describe-ambiguous", [
      "#include <SandiAutoIt.au3>",
      `Local $sDescription = SandiUIA_Describe(${identityArgs(window, identity)})`,
      "Local $iError = @error",
      "ConsoleWrite($iError)",
    ]),
  );
}

function identityArgs(window, identity) {
  return [
    `HWnd(${autoItString(window.hwnd)})`,
    String(window.pid),
    autoItString(identity.automationId),
    String(identity.controlType),
    autoItString(identity.name),
    autoItString(identity.className),
    autoItString(identity.path),
    String(identity.nativeHwnd),
  ].join(", ");
}

function identityValueArgs(window, identity, value) {
  return [
    `HWnd(${autoItString(window.hwnd)})`,
    String(window.pid),
    autoItString(identity.automationId),
    String(identity.controlType),
    autoItString(identity.name),
    autoItString(value),
    autoItString(identity.className),
    autoItString(identity.path),
    String(identity.nativeHwnd),
  ].join(", ");
}

function runAutoIt(autoit, root, label, lines) {
  const script = join(root, `${basename(label)}.au3`);
  writeFileSync(script, `${lines.join("\r\n")}\r\n`);
  const result = spawnSync(autoit, ["/ErrorStdOut", script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result.stdout.trim();
}

async function commandFixture(commandPath, ackPath, command, expectedAck) {
  rmSync(ackPath, { force: true });
  writeFileSync(commandPath, command);
  await waitForFile(ackPath, `fixture command ${command}`);
  assert.equal(readFileSync(ackPath, "utf8"), expectedAck);
}

async function waitForFile(path, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout(null), timeoutMs),
    ),
  ]);
}

function autoItString(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
