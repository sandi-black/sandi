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
import { screenshot } from "@/surfaces/api/client/desktop-state";
import {
  type VisualObservation,
  VisualObservationEnvelopeSchema,
} from "@/surfaces/api/client/visual-observation";

const executableArg = process.argv[2];
if (!executableArg) {
  throw new Error("usage: verify-autoit-visual <AutoIt3_x64.exe>");
}
const executable = isAbsolute(executableArg)
  ? executableArg
  : resolve(process.cwd(), executableArg);
assert(existsSync(executable), `AutoIt runtime is missing: ${executable}`);

const root = mkdtempSync(join(tmpdir(), "sandi-autoit-visual-"));
const ready = join(root, "fixture.ready");
const state = join(root, "fixture.state");
const reset = join(root, "fixture.reset");
const fixturePath = join(root, "fixture.au3");
const cancelActive = join(root, "cancel.active");
writeFileSync(fixturePath, visualFixture({ ready, state, reset }), "utf8");
const fixture = spawn(executable, ["/ErrorStdOut", fixturePath], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
let fixtureError = "";
fixture.stderr.setEncoding("utf8");
fixture.stderr.on("data", (chunk: string) => {
  fixtureError += chunk;
});

try {
  await waitUntil(
    () => existsSync(ready),
    () => `visual fixture readiness; stderr=${fixtureError}`,
  );
  const identity = readIdentity(readFileSync(ready, "utf8"));
  verifyCoordinateConversion();

  await activate(identity.hwnd);
  const initial = await observe(identity.hwnd);
  assert.equal(initial.observation.target.pid, identity.pid);
  assert.equal(initial.observation.active, true);

  await expectRefusal(
    identity,
    initial.observation,
    [
      "Local $aPosition = WinGetPos($hWnd)",
      'WinMove($hWnd, "", $aPosition[0] + 40, $aPosition[1] + 30)',
      "WinActivate($hWnd)",
      'WinWaitActive($hWnd, "", 3)',
    ],
    "moved target",
  );
  await activate(identity.hwnd);
  const moved = await observe(identity.hwnd);

  await expectRefusal(
    identity,
    moved.observation,
    [
      "Local $aPosition = WinGetPos($hWnd)",
      'WinMove($hWnd, "", $aPosition[0], $aPosition[1], $aPosition[2] + 70, $aPosition[3] + 45)',
      "WinActivate($hWnd)",
      'WinWaitActive($hWnd, "", 3)',
    ],
    "resized target",
  );
  await activate(identity.hwnd);
  const resized = await observe(identity.hwnd);

  await expectRefusal(identity, resized.observation, [], "DPI change", {
    dpi: resized.observation.dpi + 24,
  });
  await expectRefusal(
    identity,
    resized.observation,
    [
      `WinActivate(HWnd(${identity.decoyHwnd}))`,
      `WinWaitActive(HWnd(${identity.decoyHwnd}), "", 3)`,
    ],
    "focus loss",
  );
  await activate(identity.hwnd);
  await expectRefusal(identity, resized.observation, [], "recycled HWND/PID", {
    pid: identity.pid + 1,
  });
  await expectRefusal(
    identity,
    resized.observation,
    [],
    "out-of-bounds normalized coordinate",
    { normalizedX: 1 },
  );
  await expectRefusal(
    identity,
    resized.observation,
    [],
    "inconsistent screenshot scale",
    { screenshotWidth: resized.observation.screenshot.width - 7 },
  );
  assert.equal(readState(), "idle");

  await activate(identity.hwnd);
  const beforeClick = await observe(identity.hwnd);
  const normalizedX = 200 / beforeClick.observation.clientRect.width;
  const normalizedY = 130 / beforeClick.observation.clientRect.height;
  const clicked = runDirect(
    guardedScript(
      identity,
      beforeClick.observation,
      normalizedX,
      normalizedY,
      [],
      ["If Not $bResult Then Exit 31", 'ConsoleWrite("clicked=ok" & @CRLF)'],
    ),
  );
  assert.equal(clicked.status, 0, clicked.stderr || clicked.stdout);
  assert.equal(clicked.stdout.trim(), "clicked=ok");
  await waitUntil(() => readState() === "clicked", "custom target click");
  const afterClick = await observe(identity.hwnd);
  assert.notEqual(
    afterClick.imageBase64,
    beforeClick.imageBase64,
    "post-action reobservation sees the rendered state change",
  );
  assert.deepEqual(
    afterClick.observation.target,
    beforeClick.observation.target,
    "post-action reobservation retains the target identity",
  );

  writeFileSync(reset, "reset", "utf8");
  await waitUntil(() => readState() === "idle", "visual fixture reset");
  await activate(identity.hwnd);
  const cancellationObservation = await observe(identity.hwnd);
  const controller = new AbortController();
  const cancellation = runScript(
    guardedScript(
      identity,
      cancellationObservation.observation,
      200 / cancellationObservation.observation.clientRect.width,
      130 / cancellationObservation.observation.clientRect.height,
      [],
      [
        "If Not $bResult Then Exit 41",
        'MouseDown("left")',
        '$__g_SandiInputMouseButton = "left"',
        'DllCall("user32.dll", "none", "keybd_event", "byte", 0x11, "byte", 0, "dword", 0, "ulong_ptr", 0)',
        `FileWrite(${autoItString(cancelActive)}, "active")`,
        "While True",
        "    Sleep(100)",
        "WEnd",
      ],
    ),
    controller.signal,
  );
  await waitUntil(() => existsSync(cancelActive), "active visual cancellation");
  const cancelStarted = Date.now();
  controller.abort();
  assert.equal((await cancellation).kind, "cancelled");
  assert(Date.now() - cancelStarted < 3_000, "visual cancellation is prompt");
  verifyInputReleased();

  console.log(
    "AutoIt visual verification passed: stale observations refuse and a custom-rendered target reobserves after click",
  );
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

type FixtureIdentity = { hwnd: string; pid: number; decoyHwnd: string };

type ObservationResult = {
  observation: VisualObservation;
  imageBase64: string;
};

type ObservationOverrides = {
  pid?: number;
  normalizedX?: number;
  normalizedY?: number;
  dpi?: number;
  screenshotWidth?: number;
};

function readIdentity(raw: string): FixtureIdentity {
  const [hwnd, pidText, decoyHwnd] = raw.trim().split("|");
  const pid = Number(pidText);
  if (
    hwnd === undefined ||
    !/^\d+$/.test(hwnd) ||
    decoyHwnd === undefined ||
    !/^\d+$/.test(decoyHwnd) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    throw new Error(`visual fixture returned an invalid identity: ${raw}`);
  }
  return { hwnd, pid, decoyHwnd };
}

async function activate(hwnd: string): Promise<void> {
  const result = runDirect([
    `Local $hWnd = HWnd(${hwnd})`,
    "WinActivate($hWnd)",
    'If Not WinWaitActive($hWnd, "", 3) Then Exit 12',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function observe(hwnd: string): Promise<ObservationResult> {
  const outcome = await screenshot({ window: hwnd, maxDimension: 240 });
  assert(outcome.ok, outcome.error ?? "window screenshot failed");
  const parsed = VisualObservationEnvelopeSchema.safeParse(
    outcome.structuredContent,
  );
  assert(
    parsed.success,
    "window screenshot returns the visual observation contract",
  );
  const image = outcome.content.find((block) => block.type === "image");
  assert(image !== undefined, "window screenshot returns an image");
  return {
    observation: parsed.data.visualObservation,
    imageBase64: image.dataBase64,
  };
}

async function expectRefusal(
  identity: FixtureIdentity,
  observation: VisualObservation,
  prelude: readonly string[],
  label: string,
  overrides: ObservationOverrides = {},
): Promise<void> {
  const result = runDirect(
    guardedScript(
      identity,
      observation,
      overrides.normalizedX ?? 200 / observation.clientRect.width,
      overrides.normalizedY ?? 130 / observation.clientRect.height,
      prelude,
      [
        "If $bResult Then Exit 21",
        "If $iVisualError < $SANDI_VISUAL_ERROR_ARGUMENT Or $iVisualError > $SANDI_VISUAL_ERROR_INPUT Then Exit 22",
        'ConsoleWrite("refused=ok" & @CRLF)',
      ],
      overrides,
    ),
  );
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  assert.equal(result.stdout.trim(), "refused=ok", label);
}

function guardedScript(
  identity: FixtureIdentity,
  observation: VisualObservation,
  normalizedX: number,
  normalizedY: number,
  prelude: readonly string[],
  after: readonly string[],
  overrides: ObservationOverrides = {},
): string[] {
  const pid = overrides.pid ?? observation.target.pid;
  const dpi = overrides.dpi ?? observation.dpi;
  const screenshotWidth =
    overrides.screenshotWidth ?? observation.screenshot.width;
  return [
    "#include <SandiAutoIt.au3>",
    `Local $hWnd = HWnd(${identity.hwnd})`,
    `Local $iPid = ${pid}`,
    ...prelude,
    `Local $bResult = ${visualClickCall(
      observation,
      normalizedX,
      normalizedY,
      pid,
      dpi,
      screenshotWidth,
    )}`,
    "Local $iVisualError = @error",
    ...after,
  ];
}

function visualClickCall(
  observation: VisualObservation,
  normalizedX: number,
  normalizedY: number,
  pid: number,
  dpi: number,
  screenshotWidth: number,
): string {
  const rect = observation.clientRect;
  const origin = observation.clientOriginScreen;
  return [
    "SandiVisual_Click($hWnd",
    String(pid),
    String(normalizedX),
    String(normalizedY),
    observation.active ? "True" : "False",
    String(rect.x),
    String(rect.y),
    String(rect.width),
    String(rect.height),
    String(origin.x),
    String(origin.y),
    String(dpi),
    String(screenshotWidth),
    `${observation.screenshot.height})`,
  ].join(", ");
}

function verifyCoordinateConversion(): void {
  const result = runDirect([
    "#include <SandiAutoIt.au3>",
    "Local $x = 0, $y = 0",
    "If Not __SandiVisual_ConvertPoint(0.5, 0.5, 0, 0, 800, 600, 120, 160, 96, 800, 600, $x, $y) Then Exit 61",
    "If $x <> 520 Or $y <> 460 Then Exit 62",
    "If Not __SandiVisual_ConvertPoint(0.25, 0.75, 0, 0, 1280, 720, -1280, 40, 144, 640, 360, $x, $y) Then Exit 63",
    "If $x <> -960 Or $y <> 580 Then Exit 64",
    "If __SandiVisual_ConvertPoint(1, 0.5, 0, 0, 800, 600, 0, 0, 96, 400, 300, $x, $y) Then Exit 65",
    'ConsoleWrite("conversion=ok" & @CRLF)',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "conversion=ok");
}

function verifyInputReleased(): void {
  const result = runDirect([
    'Local $left = DllCall("user32.dll", "short", "GetAsyncKeyState", "int", 0x01)',
    'Local $control = DllCall("user32.dll", "short", "GetAsyncKeyState", "int", 0x11)',
    'MouseUp("left")',
    'DllCall("user32.dll", "none", "keybd_event", "byte", 0x11, "byte", 0, "dword", 2, "ulong_ptr", 0)',
    'ConsoleWrite(BitAND($left[0], 0x8000) & "|" & BitAND($control[0], 0x8000) & @CRLF)',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "0|0");
}

function readState(): string {
  return existsSync(state) ? readFileSync(state, "utf8").trim() : "";
}

function runDirect(lines: readonly string[]) {
  const runDir = mkdtempSync(join(root, "direct-"));
  const artifact = join(runDir, "main.au3");
  writeFileSync(artifact, `${lines.join("\r\n")}\r\n`, "utf8");
  return spawnSync(executable, ["/ErrorStdOut", artifact], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function runScript(source: readonly string[], signal: AbortSignal) {
  const runDir = mkdtempSync(join(root, "supervised-"));
  const artifact = join(runDir, "main.au3");
  writeFileSync(artifact, `${source.join("\r\n")}\r\n`, "utf8");
  return runSupervisedAutoIt({
    executable,
    artifact,
    runDir,
    cwd: root,
    env: process.env,
    timeoutMs: 20_000,
    maxOutputChars: 40_000,
    elevation: "inherit",
    signal,
  });
}

function visualFixture(paths: {
  ready: string;
  state: string;
  reset: string;
}): string {
  return `#include <GUIConstantsEx.au3>

Opt("GUIOnEventMode", 0)
Local $hTarget = GUICreate("Sandi visual canvas target", 480, 300, 120, 120)
GUISetBkColor(0x20242A, $hTarget)
Local $iCanvas = GUICtrlCreateGraphic(0, 0, 480, 300)
Local $hDecoy = GUICreate("Sandi visual decoy", 240, 120, 720, 120)
GUICtrlCreateLabel("Focus moved here", 30, 40, 180, 24)
GUISetState(@SW_SHOW, $hDecoy)
GUISetState(@SW_SHOW, $hTarget)
WinActivate($hTarget)
WinWaitActive($hTarget, "", 3)
FileDelete(${autoItString(paths.state)})
FileWrite(${autoItString(paths.state)}, "idle")
__DrawTarget(False)
FileWrite(${autoItString(paths.ready)}, Number($hTarget) & "|" & @AutoItPID & "|" & Number($hDecoy))

While True
    Local $iMessage = GUIGetMsg()
    If $iMessage = $GUI_EVENT_CLOSE Then ExitLoop
    If $iMessage = $iCanvas Or $iMessage = $GUI_EVENT_PRIMARYDOWN Then
        Local $aCursor = GUIGetCursorInfo($hTarget)
        If IsArray($aCursor) And $aCursor[0] >= 120 And $aCursor[0] < 280 And _
                $aCursor[1] >= 80 And $aCursor[1] < 180 Then
            FileDelete(${autoItString(paths.state)})
            FileWrite(${autoItString(paths.state)}, "clicked")
            __DrawTarget(True)
        EndIf
    EndIf
    If FileExists(${autoItString(paths.reset)}) Then
        FileDelete(${autoItString(paths.reset)})
        FileDelete(${autoItString(paths.state)})
        FileWrite(${autoItString(paths.state)}, "idle")
        __DrawTarget(False)
    EndIf
    Sleep(10)
WEnd

Func __DrawTarget($bClicked)
    GUICtrlSetGraphic($iCanvas, $GUI_GR_REFRESH)
    GUICtrlSetGraphic($iCanvas, $GUI_GR_COLOR, 0x20242A, 0x20242A)
    GUICtrlSetGraphic($iCanvas, $GUI_GR_RECT, 0, 0, 479, 299)
    Local $iColor = 0xD64545
    If $bClicked Then $iColor = 0x3AA76D
    GUICtrlSetGraphic($iCanvas, $GUI_GR_COLOR, $iColor, $iColor)
    GUICtrlSetGraphic($iCanvas, $GUI_GR_RECT, 120, 80, 160, 100)
EndFunc
`;
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function waitUntil(
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(
    `timed out waiting for ${typeof label === "function" ? label() : label}`,
  );
}
