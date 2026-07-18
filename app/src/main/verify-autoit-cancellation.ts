import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { QueueState, TurnSettledEvent } from "@shared/ipc-contract";

import { createTurnManager } from "./turn-manager";
import { ContextCompiler } from "@sandi-server/lib/context/context-compiler";
import { ConversationStore } from "@sandi-server/lib/conversations/store";
import {
  type ModelProviderClient,
  type ProviderProbe,
  ProviderTurnError,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
} from "@sandi-server/lib/provider/pi-cli-client";
import { ApiBot } from "@sandi-server/surfaces/api/bot/api-bot";
import {
  type DesktopToolExecutor,
  runDesktopClient,
} from "@sandi-server/surfaces/api/client/desktop-client";
import { executeLocalTool } from "@sandi-server/surfaces/api/client/executors";
import type { LocalScriptRuntimeContext } from "@sandi-server/surfaces/api/client/local-script-runtimes";
import { sendTurn } from "@sandi-server/surfaces/api/client/turns";
import type { ApiAppConfig } from "@sandi-server/surfaces/api/config";
import { DeviceRegistry } from "@sandi-server/surfaces/api/devices/device-registry";
import { ToolBroker } from "@sandi-server/surfaces/api/devices/tool-broker";
import {
  callBroker,
  type ToolCallOutcome,
} from "@sandi-server/surfaces/api/pi-extension/tool-broker-client";
import { API_SURFACE_CONTEXT } from "@sandi-server/surfaces/api/runtime/context";

const TOKEN = "54".repeat(32);
const IDENTITY_ID = "grace-hopper";
const DEVICE_ID = "cancellation-verifier";
const CANCELLATION_LIMIT_MS = 5_000;

type Scenario = {
  name: string;
  code: string;
  timeoutMs: number;
};

type ScenarioResult =
  | { kind: "completed"; outcome: ToolCallOutcome }
  | { kind: "cancelled" };

class AutomationProvider implements ModelProviderClient {
  readonly #scenarios: Scenario[] = [];
  readonly #results = new Map<string, ScenarioResult>();
  readonly #waiters = new Map<string, (result: ScenarioResult) => void>();

  enqueue(scenario: Scenario): void {
    this.#scenarios.push(scenario);
  }

  result(name: string): Promise<ScenarioResult> {
    const existing = this.#results.get(name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveResult) => {
      this.#waiters.set(name, resolveResult);
    });
  }

  async probe(): Promise<ProviderProbe> {
    return {
      command: { ok: true, detail: "ok" },
      version: { ok: true, detail: "ok" },
      model: { ok: true, detail: "ok" },
    };
  }

  async generateTurn(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    const scenario = this.#scenarios.shift();
    if (!scenario)
      throw new Error("no AutoIt verification scenario was queued");
    if (!request.localToolBroker) {
      throw new Error("the verification turn did not receive desktop hands");
    }
    try {
      const outcome = await callBroker(
        request.localToolBroker,
        "local_autoit_run",
        { code: scenario.code, timeoutMs: scenario.timeoutMs },
        request.signal,
      );
      this.#settle(scenario.name, { kind: "completed", outcome });
      return {
        text: `${scenario.name} completed`,
        deliverySideEffects: false,
        signals: [],
        raw: outcome,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        this.#settle(scenario.name, { kind: "cancelled" });
        throw new ProviderTurnError({
          message: "desktop automation turn was stopped",
          reason: "aborted",
          exitCode: null,
          stderr: "aborted",
        });
      }
      throw error;
    }
  }

  #settle(name: string, result: ScenarioResult): void {
    this.#results.set(name, result);
    this.#waiters.get(name)?.(result);
    this.#waiters.delete(name);
  }
}

type TurnHarness = {
  submit(name: string): Promise<TurnSettledEvent>;
  stop(turnId: string): void;
  state(conversationId: string): QueueState;
};

async function main(): Promise<void> {
  const executableArg = process.argv[2];
  if (!executableArg) {
    throw new Error(
      "usage: verify-autoit-cancellation <AutoIt3_x64.exe> [--guarded]",
    );
  }
  const executable = isAbsolute(executableArg)
    ? executableArg
    : resolve(process.cwd(), executableArg);
  assert(existsSync(executable), `AutoIt runtime is missing: ${executable}`);
  const guarded = process.argv.includes("--guarded");
  if (guarded) requireElevatedTerminal(executable);

  const root = mkdtempSync(join(tmpdir(), "sandi-autoit-cancel-e2e-"));
  const runRoot = join(root, "local-runs");
  const provider = new AutomationProvider();
  const devices = new DeviceRegistry();
  const broker = new ToolBroker(devices);
  let bot: ApiBot | undefined;
  const linkController = new AbortController();
  let link: Promise<void> | undefined;
  let fixture: ReturnType<typeof spawn> | undefined;

  try {
    const config = testConfig(root);
    await writeFixtures(config);
    await broker.start();
    bot = new ApiBot({
      config,
      conversations: new ConversationStore(root),
      contextCompiler: new ContextCompiler(
        config.paths.configDirs,
        config.paths.dataDir,
        API_SURFACE_CONTEXT,
      ),
      provider,
      devices,
      broker,
    });
    await bot.start();
    const port = bot.address()?.port;
    if (!port) throw new Error("API bot did not expose a listening port");
    const url = `http://127.0.0.1:${port}`;
    const runtimes = localRuntimes(executable, runRoot);
    const linked = deferred<void>();
    link = runDesktopClient({
      credentials: {
        url,
        token: TOKEN,
        identityId: IDENTITY_ID,
        deviceId: DEVICE_ID,
      },
      rootDir: root,
      signal: linkController.signal,
      executeTool: desktopExecutor(runtimes),
      onStatus: (status) => {
        if (status === "linked") linked.resolve();
      },
    });
    await withDeadline(linked.promise, 5_000, "desktop link readiness");

    const turns = turnHarness(url);
    const fixtureState = guarded
      ? await startGuardedFixture(executable, root)
      : undefined;
    fixture = fixtureState?.process;

    await verifyCancellation({
      provider,
      turns,
      root,
      runRoot,
      ...(fixtureState ? { guardedFixture: fixtureState } : {}),
    });
    await verifyRecovery(provider, turns, root, fixtureState);
    await verifyTimeout(provider, turns, root, fixtureState);
    await verifyFailure(provider, turns);
    assert.equal(
      turns.state("desktop-cancellation").inflightTurnId,
      undefined,
      "the desktop turn queue is reusable after every outcome",
    );

    console.log(
      guarded
        ? "AutoIt guarded cancellation verification passed"
        : "AutoIt end-to-end cancellation verification passed",
    );
  } finally {
    if (fixture?.pid !== undefined) terminateTree(fixture.pid);
    linkController.abort();
    if (link) await link;
    bot?.stop();
    devices.closeAll();
    broker.stop();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 40,
      retryDelay: 50,
    });
  }
}

async function verifyCancellation(input: {
  provider: AutomationProvider;
  turns: TurnHarness;
  root: string;
  runRoot: string;
  guardedFixture?: GuardedFixture;
}): Promise<void> {
  const active = join(input.root, "cancel.active");
  const ownerPidPath = join(input.root, "cancel-owner.pid");
  const descendantPidPath = join(input.root, "cancel-descendant.pid");
  const actions = join(input.root, "cancel-actions.log");
  const descendant = writeDescendant(input.root, "cancel", descendantPidPath);
  input.provider.enqueue({
    name: "cancel",
    code: input.guardedFixture
      ? guardedCancellationSource({
          fixture: input.guardedFixture,
          active,
          ownerPidPath,
          descendant,
          actions,
        })
      : cancellationSource({
          active,
          ownerPidPath,
          descendant,
          actions,
        }),
    timeoutMs: 30_000,
  });
  const supervisorPidsBefore = supervisorPids(input.runRoot);
  const settled = input.turns.submit("cancel");
  await waitUntil(
    () =>
      existsSync(active) &&
      existsSync(ownerPidPath) &&
      existsSync(descendantPidPath) &&
      (!input.guardedFixture || input.guardedFixture.readPrimary().length > 0),
    "active production AutoIt action",
  );
  const ownerPid = readPid(ownerPidPath);
  const descendantPid = readPid(descendantPidPath);
  assert(isProcessRunning(ownerPid), "the owning AutoIt process is active");
  assert(
    isProcessRunning(descendantPid),
    "the active AutoIt descendant is active",
  );
  const supervisorPid = input.guardedFixture
    ? onlyNewSupervisor(input.runRoot, supervisorPidsBefore)
    : undefined;
  if (supervisorPid !== undefined) {
    assert(
      isProcessRunning(supervisorPid),
      "the elevation supervisor is active",
    );
  }

  const stoppedAt = Date.now();
  input.turns.stop("turn-cancel");
  const event = await withDeadline(
    settled,
    CANCELLATION_LIMIT_MS,
    "desktop Stop acknowledgement",
  );
  assert.equal(event.ok, false, "a stopped turn does not report success");
  assert.equal(event.error, "stopped", "the user sees a stopped outcome");
  assert(
    Date.now() - stoppedAt < CANCELLATION_LIMIT_MS,
    "desktop Stop settles promptly",
  );
  assert.deepEqual(await input.provider.result("cancel"), {
    kind: "cancelled",
  });
  await waitUntil(
    () =>
      !isProcessRunning(ownerPid) &&
      !isProcessRunning(descendantPid) &&
      (supervisorPid === undefined || !isProcessRunning(supervisorPid)),
    "cancelled AutoIt process-tree cleanup",
    CANCELLATION_LIMIT_MS,
  );
  assert(
    Date.now() - stoppedAt < CANCELLATION_LIMIT_MS,
    "the AutoIt process tree terminates promptly",
  );

  const actionsAtAck = readOptional(actions);
  const inputAtAck = input.guardedFixture?.readPrimary();
  await delay(300);
  assert.equal(
    readOptional(actions),
    actionsAtAck,
    "no native action occurs after cancellation is acknowledged",
  );
  if (input.guardedFixture) {
    assert.equal(
      input.guardedFixture.readPrimary(),
      inputAtAck,
      "no later keystroke lands after cancellation is acknowledged",
    );
    assert.equal(
      input.guardedFixture.readDecoy(),
      "",
      "cancelled input never redirects into another control",
    );
  }
}

async function verifyRecovery(
  provider: AutomationProvider,
  turns: TurnHarness,
  root: string,
  fixture?: GuardedFixture,
): Promise<void> {
  const recovered = join(root, "recovered.marker");
  if (fixture) await fixture.reset();
  provider.enqueue({
    name: "recovery",
    code: fixture
      ? fixtureInputSource(fixture, recovered, "release-probe")
      : `FileWrite(${autoItString(recovered)}, "ok")\r\nExit 0`,
    timeoutMs: 5_000,
  });
  const event = await turns.submit("recovery");
  assert(
    event.ok,
    "a later local_autoit_run succeeds on the same desktop link",
  );
  assert.equal(readOptional(recovered), "ok");
  if (fixture) {
    await waitUntil(
      () => fixture.readPrimary() === "release-probe",
      "guarded-input release probe",
    );
  }
  const result = await provider.result("recovery");
  assert(result.kind === "completed" && result.outcome.ok);
}

async function verifyTimeout(
  provider: AutomationProvider,
  turns: TurnHarness,
  root: string,
  fixture?: GuardedFixture,
): Promise<void> {
  if (fixture) await fixture.reset();
  provider.enqueue({
    name: "timeout",
    code: fixture
      ? guardedTimeoutSource(fixture)
      : "While True\r\n    Sleep(25)\r\nWEnd",
    timeoutMs: 500,
  });
  const event = await turns.submit("timeout");
  assert(
    event.ok,
    "a tool timeout is returned to the model without stopping the turn",
  );
  const result = await provider.result("timeout");
  assert(result.kind === "completed", "timeout returns a tool result");
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.isError, true);
  assert.equal(result.outcome.structuredContent?.["timedOut"], true);
  assert.equal(result.outcome.structuredContent?.["cancelled"], false);
  if (!fixture) return;

  const inputAtTimeout = fixture.readPrimary();
  await delay(300);
  assert.equal(
    fixture.readPrimary(),
    inputAtTimeout,
    "no later keystroke lands after timeout cleanup",
  );
  assert.equal(fixture.readDecoy(), "");
  await fixture.reset();
  const released = join(root, "timeout-released.marker");
  provider.enqueue({
    name: "timeout-release",
    code: fixtureInputSource(fixture, released, "timeout-release"),
    timeoutMs: 5_000,
  });
  const releaseEvent = await turns.submit("timeout-release");
  assert(releaseEvent.ok, "a run after timeout succeeds without relinking");
  await waitUntil(
    () => fixture.readPrimary() === "timeout-release",
    "timeout input-release probe",
  );
}

async function verifyFailure(
  provider: AutomationProvider,
  turns: TurnHarness,
): Promise<void> {
  provider.enqueue({ name: "failure", code: "Exit 7", timeoutMs: 5_000 });
  const event = await turns.submit("failure");
  assert(event.ok, "an ordinary tool failure remains model-visible");
  const result = await provider.result("failure");
  assert(result.kind === "completed", "ordinary failure returns a tool result");
  assert.equal(result.outcome.ok, true);
  assert.equal(result.outcome.isError, true);
  assert.equal(result.outcome.structuredContent?.["timedOut"], false);
  assert.equal(result.outcome.structuredContent?.["cancelled"], false);
  assert.equal(result.outcome.structuredContent?.["exitCode"], 7);
}

function turnHarness(url: string): TurnHarness {
  const settlements = new Map<string, TurnSettledEvent>();
  const waiters = new Map<string, (event: TurnSettledEvent) => void>();
  const manager = createTurnManager({
    sendTurn: ({ conversationId, text, turnId, signal }) =>
      sendTurn({
        url,
        token: TOKEN,
        conversationId,
        input: text,
        turnId,
        signal,
      }),
    events: {
      onTurnStarted: () => undefined,
      onTurnSettled: (event) => {
        settlements.set(event.turnId, event);
        waiters.get(event.turnId)?.(event);
        waiters.delete(event.turnId);
      },
      onQueueState: () => undefined,
    },
  });
  return {
    submit(name) {
      const turnId = `turn-${name}`;
      const settled = new Promise<TurnSettledEvent>((resolveSettled) => {
        const existing = settlements.get(turnId);
        if (existing) resolveSettled(existing);
        else waiters.set(turnId, resolveSettled);
      });
      manager.submit({
        conversationId: "desktop-cancellation",
        text: name,
        turnId,
        attachmentIds: [],
      });
      return settled;
    },
    stop: (turnId) => manager.stop(turnId),
    state: (conversationId) => manager.queueState(conversationId),
  };
}

function desktopExecutor(
  runtimes: LocalScriptRuntimeContext,
): DesktopToolExecutor {
  return (call, context, signal) =>
    executeLocalTool(
      call,
      { ...context, localScriptRuntimes: runtimes },
      signal,
    );
}

function localRuntimes(
  executable: string,
  runRoot: string,
): LocalScriptRuntimeContext {
  return {
    runRoot,
    javascript: {
      executable: process.execPath,
      version: process.versions.node,
    },
    autoit: {
      executable,
      version: "verification",
      checker: { executable: join(dirname(executable), "Au3Check.exe") },
    },
  };
}

function cancellationSource(input: {
  active: string;
  ownerPidPath: string;
  descendant: string;
  actions: string;
}): string {
  return [
    `FileWrite(${autoItString(input.ownerPidPath)}, @AutoItPID)`,
    `Run('"' & @AutoItExe & '" /ErrorStdOut "' & ${autoItString(input.descendant)} & '"', "", @SW_HIDE)`,
    `FileWrite(${autoItString(input.active)}, "active")`,
    "While True",
    `    FileWrite(${autoItString(input.actions)}, "action" & @CRLF)`,
    "    Sleep(25)",
    "WEnd",
  ].join("\r\n");
}

function guardedCancellationSource(input: {
  fixture: GuardedFixture;
  active: string;
  ownerPidPath: string;
  descendant: string;
  actions: string;
}): string {
  return [
    "#RequireAdmin",
    "#include <String.au3>",
    "#include <SandiAutoIt.au3>",
    `Local $hWnd = HWnd(${input.fixture.window})`,
    `Local $iPid = ${input.fixture.pid}`,
    "WinActivate($hWnd)",
    'If Not WinWaitActive($hWnd, "", 3) Then Exit 10',
    'If Not ControlFocus($hWnd, "", "Edit1") Then Exit 11',
    `FileWrite(${autoItString(input.ownerPidPath)}, @AutoItPID)`,
    `Run('"' & @AutoItExe & '" /ErrorStdOut "' & ${autoItString(input.descendant)} & '"', "", @SW_HIDE)`,
    `FileWrite(${autoItString(input.active)}, "active")`,
    `FileWrite(${autoItString(input.actions)}, "input-started" & @CRLF)`,
    'SandiInput_TypeText($hWnd, $iPid, "3", $SANDI_UIA_EDIT, "", _StringRepeat("x", 8000))',
    `FileWrite(${autoItString(input.actions)}, "input-finished" & @CRLF)`,
  ].join("\r\n");
}

function guardedTimeoutSource(fixture: GuardedFixture): string {
  return [
    "#RequireAdmin",
    "#include <String.au3>",
    "#include <SandiAutoIt.au3>",
    `Local $hWnd = HWnd(${fixture.window})`,
    `Local $iPid = ${fixture.pid}`,
    "WinActivate($hWnd)",
    'If Not WinWaitActive($hWnd, "", 3) Then Exit 10',
    'If Not ControlFocus($hWnd, "", "Edit1") Then Exit 11',
    'SandiInput_TypeText($hWnd, $iPid, "3", $SANDI_UIA_EDIT, "", _StringRepeat("t", 8000))',
  ].join("\r\n");
}

function fixtureInputSource(
  fixture: GuardedFixture,
  marker: string,
  text: string,
): string {
  return [
    "#include <AutoItConstants.au3>",
    `Local $hWnd = HWnd(${fixture.window})`,
    `Local $iPid = ${fixture.pid}`,
    "WinActivate($hWnd)",
    'If Not WinWaitActive($hWnd, "", 3) Then Exit 10',
    'If Not ControlFocus($hWnd, "", "Edit1") Then Exit 11',
    `Send(${autoItString(text)}, $SEND_RAW)`,
    `FileWrite(${autoItString(marker)}, "ok")`,
  ].join("\r\n");
}

function writeDescendant(root: string, name: string, pidPath: string): string {
  const path = join(root, `${name}-descendant.au3`);
  writeFileSync(
    path,
    [
      `FileWrite(${autoItString(pidPath)}, @AutoItPID)`,
      "While True",
      "    Sleep(25)",
      "WEnd",
    ].join("\r\n"),
    "utf8",
  );
  return path;
}

type GuardedFixture = {
  process: ReturnType<typeof spawn>;
  window: string;
  pid: number;
  readPrimary(): string;
  readDecoy(): string;
  reset(): Promise<void>;
};

async function startGuardedFixture(
  executable: string,
  root: string,
): Promise<GuardedFixture> {
  const ready = join(root, "fixture.ready");
  const mode = join(root, "fixture.mode");
  const modeReady = join(root, "fixture.mode-ready");
  const state = join(root, "fixture.state");
  const script = join(root, "guarded-fixture.au3");
  writeFileSync(
    script,
    fixtureSource({ ready, mode, modeReady, state }),
    "utf8",
  );
  const process = spawn(executable, ["/ErrorStdOut", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitUntil(() => existsSync(ready), "guarded fixture readiness");
    const [window, rawPid] = readFileSync(ready, "utf8").trim().split("|");
    const pid = Number(rawPid);
    assert(
      window && Number.isSafeInteger(pid) && pid > 0,
      "fixture identity is valid",
    );
    let sequence = 0;
    const readState = (): [string, string] => {
      const [primary = "", decoy = ""] = readOptional(state).split(/\r?\n/, 2);
      return [primary, decoy];
    };
    return {
      process,
      window,
      pid,
      readPrimary: () => readState()[0],
      readDecoy: () => readState()[1],
      async reset() {
        const command = `reset|${++sequence}`;
        writeFileSync(mode, command, "utf8");
        await waitUntil(
          () => readOptional(modeReady).trim() === command,
          "guarded fixture reset",
        );
        await waitUntil(
          () => readState()[0] === "" && readState()[1] === "",
          "empty guarded fixture",
        );
      },
    };
  } catch (error) {
    if (process.pid !== undefined) terminateTree(process.pid);
    throw error;
  }
}

function fixtureSource(paths: {
  ready: string;
  mode: string;
  modeReady: string;
  state: string;
}): string {
  return `#include <GUIConstantsEx.au3>

Local $hWindow = GUICreate("Sandi cancellation target", 420, 180, 120, 120)
Local $iPrimary = GUICtrlCreateInput("", 20, 20, 360, 24)
Local $iDecoy = GUICtrlCreateInput("", 20, 65, 360, 24)
GUISetState(@SW_SHOW, $hWindow)
FileWrite(${autoItString(paths.ready)}, Number($hWindow) & "|" & @AutoItPID)
Local $sLastMode = ""
Local $sLastState = ""

While True
    If GUIGetMsg() = $GUI_EVENT_CLOSE Then ExitLoop
    Local $sMode = StringStripWS(FileRead(${autoItString(paths.mode)}), 3)
    If $sMode <> $sLastMode Then
        GUICtrlSetData($iPrimary, "")
        GUICtrlSetData($iDecoy, "")
        GUICtrlSetState($iPrimary, $GUI_FOCUS)
        $sLastMode = $sMode
        Local $hReady = FileOpen(${autoItString(paths.modeReady)}, 2)
        FileWrite($hReady, $sMode)
        FileClose($hReady)
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

function requireElevatedTerminal(executable: string): void {
  const probe = join(tmpdir(), `sandi-admin-${process.pid}.au3`);
  writeFileSync(probe, "ConsoleWrite(Number(IsAdmin()))\r\n", "utf8");
  try {
    const result = spawnSync(executable, ["/ErrorStdOut", probe], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || result.stdout.trim() !== "1") {
      throw new Error(
        "guarded cancellation verification requires an already-elevated terminal and never requests UAC",
      );
    }
  } finally {
    rmSync(probe, { force: true });
  }
}

function supervisorPids(runRoot: string): Set<number> {
  const pids = new Set<number>();
  if (!existsSync(runRoot)) return pids;
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const started = join(runRoot, entry.name, "supervisor.started");
    if (!existsSync(started)) continue;
    const match = /^pid=(\d+);admin=1/m.exec(readFileSync(started, "utf8"));
    if (match?.[1]) pids.add(Number(match[1]));
  }
  return pids;
}

function onlyNewSupervisor(runRoot: string, before: Set<number>): number {
  const added = [...supervisorPids(runRoot)].filter((pid) => !before.has(pid));
  assert.equal(
    added.length,
    1,
    "one elevated supervisor owns the active script",
  );
  const pid = added[0];
  assert(pid !== undefined);
  return pid;
}

function terminateTree(pid: number): void {
  spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  assert(Number.isSafeInteger(pid) && pid > 0, `valid process id in ${path}`);
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(
      () => rejectValue(new Error(`timed out waiting for ${label}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function writeFixtures(config: ApiAppConfig): Promise<void> {
  await mkdir(join(config.paths.configDir, "identities"), { recursive: true });
  await writeFile(
    join(config.paths.configDir, "identities", "humans.json"),
    `${JSON.stringify(
      {
        version: 1,
        humans: [
          {
            id: IDENTITY_ID,
            displayName: "Grace Hopper",
            platforms: { discord: { id: "154", username: "grace" } },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    config.api.tokensPath,
    `${JSON.stringify(
      {
        version: 1,
        tokens: [
          {
            tokenSha256: createHash("sha256").update(TOKEN).digest("hex"),
            identityId: IDENTITY_ID,
            deviceId: DEVICE_ID,
            label: "cancellation verification",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function testConfig(dataDir: string): ApiAppConfig {
  const configDir = join(dataDir, "config");
  return {
    pi: {
      command: "pi",
      packageManifestPath: join(dataDir, "pi-packages.json"),
      sessionDir: join(dataDir, "pi-sessions"),
      tokenUsagePath: join(dataDir, "provider-usage", "tokens.jsonl"),
      extensionPaths: [],
      timeoutMs: 1_000,
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    paths: {
      dataDir,
      configDir,
      privateConfigDir: configDir,
      configDirs: [configDir],
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      tokensPath: join(configDir, "api-tokens.json"),
      pairingsPath: join(configDir, "api-pairings.json"),
      attachmentQuotaBytes: 2 * 1024 * 1024 * 1024,
      attachmentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      attachmentCleanupIntervalMs: 24 * 60 * 60 * 1_000,
    },
  };
}

await main();
