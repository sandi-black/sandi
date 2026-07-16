import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DeviceRegistry } from "../../src/surfaces/api/devices/device-registry";
import {
  type Broker,
  callBroker,
  type ToolCallOutcome,
} from "../../src/surfaces/api/pi-extension/tool-broker-client";

const EXPECTED_WINDOWS_TOOLS = [
  "App",
  "Click",
  "Move",
  "MultiEdit",
  "MultiSelect",
  "Screenshot",
  "Scroll",
  "Shortcut",
  "Snapshot",
  "Type",
  "Wait",
  "WaitFor",
];
const ITERATIONS = 5;
const TRACE_PREFIX = "SANDI_COMPUTER_USE_TRACE ";
const RUNTIME_ENTRY = pathToFileURL(
  resolve(import.meta.dirname, "../../src/host/runtime/index.ts"),
).href;

type SmokeInput = {
  appPid: number;
  broker: Broker;
  chromeServerId: string;
  reconnectKey: string;
  registry: DeviceRegistry;
  windowsServerId: string;
};

type Counters = {
  mcpCalls: number;
  parentModelTurns: number;
  screenshots: number;
  turns: ToolTrace[][];
};

type BenchmarkRun = Counters & {
  durationMs: number;
  failure?: string;
  failures: number;
};

type ToolTrace = {
  serverId: string;
  toolName: string;
};

type ProcessRecord = {
  commandLine: string;
  owner: string;
  processId: number;
};

export async function runPackagedComputerUseSmoke(
  input: SmokeInput,
): Promise<void> {
  if (process.env["SANDI_COMPUTER_USE_SMOKE"] !== "1") return;

  await verifyWindowsCatalog(input);
  await verifyCodeModeComposition(input);
  const fixture = await startBrowserFixture();
  try {
    await verifyNativeInput(input);
    await verifyBrowserAndDialog(input, fixture.url);
    await verifyDisableAndEnable(input);
    await verifyDesktopContextRecovery(input);

    const beforeReconnect = inspectOwnedServers(input.appPid);
    console.log("device-link recovery: reconnecting");
    input.registry.closeAll();
    await waitUntil(
      () => input.registry.isConnected(input.reconnectKey),
      "packaged app device-link reconnect",
    );
    await invoke(
      input,
      input.windowsServerId,
      "Snapshot",
      { use_vision: false },
      AbortSignal.timeout(20_000),
    );
    const afterReconnect = inspectOwnedServers(input.appPid);
    assert.deepEqual(
      serverProcessIds(afterReconnect),
      serverProcessIds(beforeReconnect),
      "device-link reconnect keeps app-owned MCP children alive",
    );
    console.log("device-link recovery: ok");

    const report = await benchmark(input, fixture);
    recordBenchmark(report);
    assertBenchmarkImproved(report);
  } finally {
    await fixture.close();
    await dismissDialog(input);
  }

  console.log("packaged semantic computer-use smoke: ok");
}

async function verifyWindowsCatalog(input: SmokeInput): Promise<void> {
  const outcome = await callBroker(input.broker, "local_mcp", {
    operation: "search",
    serverId: input.windowsServerId,
    query: "",
    limit: 20,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(searchToolNames(outcome), EXPECTED_WINDOWS_TOOLS);
}

async function verifyCodeModeComposition(input: SmokeInput): Promise<void> {
  const counters: Counters = {
    mcpCalls: 0,
    parentModelTurns: 0,
    screenshots: 0,
    turns: [],
  };
  await runCodeTurn(
    input,
    counters,
    'await call(windowsServerId, "Snapshot", { use_vision: false });',
  );
  assert.equal(counters.parentModelTurns, 1);
  assert.equal(counters.mcpCalls, 1);
}

async function verifyNativeInput(input: SmokeInput): Promise<void> {
  const marker = "Sandi semantic smoke";
  try {
    await invoke(input, input.windowsServerId, "Shortcut", {
      shortcut: "win+r",
    });
    await invoke(input, input.windowsServerId, "WaitFor", {
      condition: "active_window",
      text: "Run",
      timeout: 10,
    });
    const snapshot = await invoke(input, input.windowsServerId, "Snapshot", {
      use_vision: false,
    });
    const location = elementLocation(textOf(snapshot), "Run", "edit");
    await invoke(input, input.windowsServerId, "Type", {
      clear: true,
      loc: location,
      text: marker,
    });
    await invoke(input, input.windowsServerId, "WaitFor", {
      condition: "text_exists",
      text: marker,
      timeout: 10,
      window_name: "Run",
    });
    const verified = await invoke(input, input.windowsServerId, "Snapshot", {
      use_vision: false,
    });
    assert.match(textOf(verified), /Sandi semantic smoke/);
  } finally {
    await dismissDialog(input);
  }
}

async function verifyBrowserAndDialog(
  input: SmokeInput,
  fixtureUrl: string,
): Promise<void> {
  await navigateFixture(input, fixtureUrl, "smoke");
  const snapshot = await invoke(
    input,
    input.chromeServerId,
    "take_snapshot",
    {},
  );
  const nameUid = chromeUid(textOf(snapshot), "textbox", "Name");
  const saveUid = chromeUid(textOf(snapshot), "button", "Save");
  await invoke(input, input.chromeServerId, "fill", {
    uid: nameUid,
    value: "Ada Lovelace",
  });
  await invoke(input, input.chromeServerId, "click", { uid: saveUid });
  await invoke(input, input.chromeServerId, "wait_for", {
    text: ["Saved Ada Lovelace"],
    timeout: 10_000,
  });
  const verified = await invoke(
    input,
    input.chromeServerId,
    "take_snapshot",
    {},
  );
  assert.match(textOf(verified), /Saved Ada Lovelace/);
  const browserValue = /Saved (Ada Lovelace)/.exec(textOf(verified))?.[1];
  assert(browserValue);

  try {
    await invoke(input, input.windowsServerId, "Shortcut", {
      shortcut: "win+r",
    });
    await invoke(input, input.windowsServerId, "WaitFor", {
      condition: "active_window",
      text: "Run",
      timeout: 10,
    });
    const dialog = await invoke(input, input.windowsServerId, "Snapshot", {
      use_vision: false,
    });
    await invoke(input, input.windowsServerId, "Type", {
      clear: true,
      loc: elementLocation(textOf(dialog), "Run", "edit"),
      text: browserValue,
    });
    const dialogVerified = await invoke(
      input,
      input.windowsServerId,
      "Snapshot",
      { use_vision: false },
    );
    assert.match(textOf(dialogVerified), /Ada Lovelace/);
  } finally {
    await dismissDialog(input);
  }
  const backOnPage = await invoke(
    input,
    input.chromeServerId,
    "take_snapshot",
    {},
  );
  assert.match(textOf(backOnPage), /Saved Ada Lovelace/);
}

async function verifyDisableAndEnable(input: SmokeInput): Promise<void> {
  const disabled = await callBroker(input.broker, "local_mcp_configure", {
    operation: "set_enabled",
    serverId: input.windowsServerId,
    enabled: false,
  });
  assert.equal(disabled.ok, true);
  const refused = await callBroker(input.broker, "local_mcp", {
    operation: "call",
    serverId: input.windowsServerId,
    toolName: "Snapshot",
    arguments: { use_vision: false },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /disabled/);
  const enabled = await callBroker(input.broker, "local_mcp_configure", {
    operation: "set_enabled",
    serverId: input.windowsServerId,
    enabled: true,
  });
  assert.equal(enabled.ok, true);
  await invoke(input, input.windowsServerId, "Snapshot", {
    use_vision: false,
  });
}

async function verifyDesktopContextRecovery(input: SmokeInput): Promise<void> {
  const beforeSwitch = inspectOwnedServers(input.appPid);
  console.log("desktop context recovery: switching virtual desktops");
  try {
    await invoke(
      input,
      input.windowsServerId,
      "Shortcut",
      { shortcut: "win+ctrl+d" },
      AbortSignal.timeout(20_000),
    );
  } finally {
    await invoke(
      input,
      input.windowsServerId,
      "Shortcut",
      { shortcut: "win+ctrl+f4" },
      AbortSignal.timeout(20_000),
    );
  }
  const restored = await invoke(
    input,
    input.windowsServerId,
    "Snapshot",
    { use_vision: false },
    AbortSignal.timeout(20_000),
  );
  assert.match(textOf(restored), /Sandi computer-use fixture/);
  assert.deepEqual(
    serverProcessIds(inspectOwnedServers(input.appPid)),
    serverProcessIds(beforeSwitch),
    "virtual desktop switching keeps app-owned MCP children alive",
  );
  console.log("desktop context recovery: ok");
}

async function benchmark(
  input: SmokeInput,
  fixture: BrowserFixture,
): Promise<BenchmarkReport> {
  const runLocation = await calibrateRunDialog(input);
  await navigateFixture(input, fixture.url, "calibration");
  const browserLocations = await calibrateBrowser(input);

  const nativeSemantic = await repeat(
    async (counters, iteration) => {
      const marker = `Sandi native semantic ${iteration}`;
      await runCodeTurn(
        input,
        counters,
        `
await call(windowsServerId, "Shortcut", { shortcut: "win+r" });
await call(windowsServerId, "WaitFor", { condition: "active_window", text: "Run", timeout: 10 });
const snapshot = await call(windowsServerId, "Snapshot", { use_vision: false });
const location = locationOf(textOf(snapshot), "edit");
await call(windowsServerId, "Type", { clear: true, loc: location, text: ${JSON.stringify(marker)} });
await call(windowsServerId, "WaitFor", { condition: "text_exists", text: ${JSON.stringify(marker)}, timeout: 10, window_name: "Run" });
const verified = await call(windowsServerId, "Snapshot", { use_vision: false });
if (!textOf(verified).includes(${JSON.stringify(marker)})) throw new Error("native semantic marker was absent");`,
      );
    },
    () => dismissDialog(input),
  );

  const nativeScreenshot = await repeat(
    async (counters, iteration) => {
      const marker = `Sandi native screenshot ${iteration}`;
      await runDirectTurn(input, counters, async (call) => {
        await call(input.windowsServerId, "Screenshot", {});
      });
      await runCodeTurn(
        input,
        counters,
        `await call(windowsServerId, "Shortcut", { shortcut: "win+r" });
await call(windowsServerId, "Wait", { duration: 1 });`,
      );
      await runDirectTurn(input, counters, async (call) => {
        await call(input.windowsServerId, "Screenshot", {});
      });
      await runCodeTurn(
        input,
        counters,
        `await call(windowsServerId, "Type", { clear: true, loc: ${JSON.stringify(runLocation)}, text: ${JSON.stringify(marker)} });
await call(windowsServerId, "Wait", { duration: 1 });`,
      );
      await runDirectTurn(input, counters, async (call) => {
        await call(input.windowsServerId, "Screenshot", {});
      });
    },
    async (iteration) => {
      try {
        const verified = await invoke(
          input,
          input.windowsServerId,
          "Snapshot",
          { use_vision: false },
        );
        assert.match(
          textOf(verified),
          new RegExp(`Sandi native screenshot ${iteration}`),
        );
      } finally {
        await dismissDialog(input);
      }
    },
  );

  const browserSemantic = await repeat(
    async (counters, iteration) => {
      const marker = `Ada semantic ${iteration}`;
      await runCodeTurn(
        input,
        counters,
        `
const snapshot = await call(chromeServerId, "take_snapshot", {});
await call(chromeServerId, "fill", { uid: uidOf(textOf(snapshot), "textbox", "Name"), value: ${JSON.stringify(marker)} });
await call(chromeServerId, "click", { uid: uidOf(textOf(snapshot), "button", "Save") });
await call(chromeServerId, "wait_for", { text: [${JSON.stringify(`Saved ${marker}`)}], timeout: 10000 });
const verified = await call(chromeServerId, "take_snapshot", {});
if (!textOf(verified).includes(${JSON.stringify(`Saved ${marker}`)})) throw new Error("browser semantic marker was absent");`,
      );
    },
    undefined,
    (iteration) => navigateFixture(input, fixture.url, `semantic-${iteration}`),
  );

  const browserScreenshot = await repeat(
    async (counters, iteration) => {
      const marker = `Ada screenshot ${iteration}`;
      await runDirectTurn(input, counters, async (call) => {
        await call(input.windowsServerId, "Screenshot", {});
      });
      await runCodeTurn(
        input,
        counters,
        `await call(windowsServerId, "Type", { clear: true, loc: ${JSON.stringify(browserLocations.name)}, text: ${JSON.stringify(marker)} });
await call(windowsServerId, "Click", { loc: ${JSON.stringify(browserLocations.save)} });
await call(windowsServerId, "Wait", { duration: 1 });`,
      );
      await runDirectTurn(input, counters, async (call) => {
        await call(input.windowsServerId, "Screenshot", {});
      });
    },
    (iteration) =>
      waitUntil(
        () => fixture.submissions.has(`Ada screenshot ${iteration}`),
        `browser screenshot submission ${iteration}`,
        3_000,
      ),
    (iteration) =>
      navigateFixture(input, fixture.url, `screenshot-${iteration}`),
  );

  return {
    capturedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    measurement:
      "Warm packaged wall clock. Each parent-model turn is an executed tool phase: a fresh code-mode child for actions or a direct broker observation whose image payload reached the harness. Reset, calibration, cleanup, model inference, and machine-readable validation are excluded.",
    schemaVersion: 2,
    tasks: [
      summarize("native", "semantic", nativeSemantic),
      summarize("native", "screenshot", nativeScreenshot),
      summarize("browser", "semantic", browserSemantic),
      summarize("browser", "screenshot", browserScreenshot),
    ],
  };
}

type BenchmarkReport = {
  capturedAt: string;
  iterations: number;
  measurement: string;
  schemaVersion: 2;
  tasks: BenchmarkSummary[];
};

type BenchmarkSummary = {
  failures: number;
  medianDurationMs: number;
  medianMcpCalls: number;
  medianParentModelTurns: number;
  medianScreenshots: number;
  path: "screenshot" | "semantic";
  runs: BenchmarkRun[];
  task: "browser" | "native";
};

async function repeat(
  task: (counters: Counters, iteration: number) => Promise<void>,
  after?: (iteration: number) => Promise<void>,
  before?: (iteration: number) => Promise<void>,
): Promise<BenchmarkRun[]> {
  const runs: BenchmarkRun[] = [];
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    const counters: Counters = {
      mcpCalls: 0,
      parentModelTurns: 0,
      screenshots: 0,
      turns: [],
    };
    let failure: unknown;
    try {
      await before?.(iteration);
    } catch (error) {
      failure = error;
    }
    const started = performance.now();
    if (failure === undefined) {
      try {
        await task(counters, iteration);
      } catch (error) {
        failure = error;
      }
    }
    const durationMs = Math.round(performance.now() - started);
    try {
      await after?.(iteration);
    } catch (error) {
      failure ??= error;
    }
    runs.push({
      ...counters,
      durationMs,
      ...(failure === undefined ? {} : { failure: errorText(failure) }),
      failures: failure === undefined ? 0 : 1,
    });
  }
  return runs;
}

function summarize(
  task: BenchmarkSummary["task"],
  path: BenchmarkSummary["path"],
  runs: BenchmarkRun[],
): BenchmarkSummary {
  return {
    failures: runs.reduce((sum, run) => sum + run.failures, 0),
    medianDurationMs: median(runs.map((run) => run.durationMs)),
    medianMcpCalls: median(runs.map((run) => run.mcpCalls)),
    medianParentModelTurns: median(runs.map((run) => run.parentModelTurns)),
    medianScreenshots: median(runs.map((run) => run.screenshots)),
    path,
    runs,
    task,
  };
}

function assertBenchmarkImproved(report: BenchmarkReport): void {
  for (const task of ["native", "browser"] as const) {
    const semantic = report.tasks.find(
      (entry) => entry.task === task && entry.path === "semantic",
    );
    const screenshotPath = report.tasks.find(
      (entry) => entry.task === task && entry.path === "screenshot",
    );
    assert(semantic && screenshotPath);
    assert.equal(semantic.failures, 0);
    assert.equal(screenshotPath.failures, 0);
    assert(
      semantic.medianDurationMs < screenshotPath.medianDurationMs,
      `${task} semantic median must beat the screenshot path`,
    );
    assert(
      semantic.medianParentModelTurns < screenshotPath.medianParentModelTurns,
      `${task} semantic path must use fewer parent-model turns`,
    );
  }
}

function recordBenchmark(report: BenchmarkReport): void {
  const output = process.env["SANDI_COMPUTER_USE_BENCHMARK_OUTPUT"];
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(`computer-use benchmark: ${JSON.stringify(report)}`);
}

async function calibrateRunDialog(input: SmokeInput): Promise<number[]> {
  try {
    await invoke(input, input.windowsServerId, "Shortcut", {
      shortcut: "win+r",
    });
    await invoke(input, input.windowsServerId, "WaitFor", {
      condition: "active_window",
      text: "Run",
      timeout: 10,
    });
    const snapshot = await invoke(input, input.windowsServerId, "Snapshot", {
      use_vision: false,
    });
    return elementLocation(textOf(snapshot), "Run", "edit");
  } finally {
    await dismissDialog(input);
  }
}

async function calibrateBrowser(
  input: SmokeInput,
): Promise<{ name: number[]; save: number[] }> {
  await invoke(input, input.windowsServerId, "App", {
    mode: "switch",
    name: "Sandi computer-use fixture",
  });
  const snapshot = await invoke(input, input.windowsServerId, "Snapshot", {
    use_vision: false,
  });
  return {
    name: elementLocation(
      textOf(snapshot),
      "Sandi computer-use fixture",
      "edit",
      "Name",
    ),
    save: elementLocation(
      textOf(snapshot),
      "Sandi computer-use fixture",
      "button",
      "Save",
    ),
  };
}

async function navigateFixture(
  input: SmokeInput,
  url: string,
  run: string,
): Promise<void> {
  await invoke(input, input.chromeServerId, "navigate_page", {
    type: "url",
    url: `${url}?run=${encodeURIComponent(run)}`,
  });
  await invoke(input, input.chromeServerId, "wait_for", {
    text: ["Sandi computer-use fixture"],
    timeout: 10_000,
  });
}

async function runCodeTurn(
  input: SmokeInput,
  counters: Counters,
  task: string,
): Promise<void> {
  counters.parentModelTurns += 1;
  const trace = await executeCodeTurn(input, task);
  counters.turns.push(trace.calls);
  counters.mcpCalls += trace.calls.length;
  counters.screenshots += trace.calls.filter(
    (call) => call.toolName === "Screenshot",
  ).length;
  if (trace.failure !== undefined) throw new Error(trace.failure);
}

async function runDirectTurn(
  input: SmokeInput,
  counters: Counters,
  task: (
    call: (
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<ToolCallOutcome>,
  ) => Promise<void>,
): Promise<void> {
  const trace: ToolTrace[] = [];
  counters.parentModelTurns += 1;
  counters.turns.push(trace);
  await task(async (serverId, toolName, args) => {
    trace.push({ serverId, toolName });
    counters.mcpCalls += 1;
    const outcome = await invoke(input, serverId, toolName, args);
    if (toolName === "Screenshot") {
      assert(
        outcome.content.some((block) => block.type === "image"),
        "direct screenshot observation returns an image",
      );
      counters.screenshots += 1;
    }
    return outcome;
  });
}

function executeCodeTurn(
  input: SmokeInput,
  task: string,
): Promise<{ calls: ToolTrace[]; failure?: string }> {
  return new Promise((resolveTurn, rejectTurn) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        codeTurnSource(input, task),
      ],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: {
          ...process.env,
          SANDI_TOOL_BROKER_TOKEN: input.broker.token,
          SANDI_TOOL_BROKER_URL: input.broker.url,
          TSX_TSCONFIG_PATH: resolve(
            import.meta.dirname,
            "../../tsconfig.json",
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      settle(() => rejectTurn(new Error("code-mode turn timed out")));
    }, 30_000);
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => settle(() => rejectTurn(error)));
    child.on("close", (exitCode) => {
      settle(() => {
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        try {
          const trace = parseCodeTurnTrace(
            Buffer.concat(stdout).toString("utf8"),
          );
          if (exitCode !== 0 && trace.failure === undefined) {
            throw new Error(
              stderrText ||
                `code-mode turn exited ${exitCode ?? "without a status"}`,
            );
          }
          resolveTurn(trace);
        } catch (error) {
          rejectTurn(
            new Error(
              [errorText(error), stderrText].filter(Boolean).join(": "),
            ),
          );
        }
      });
    });
  });
}

function codeTurnSource(input: SmokeInput, task: string): string {
  return `
import { desktopMcp } from ${JSON.stringify(RUNTIME_ENTRY)};
const windowsServerId = ${JSON.stringify(input.windowsServerId)};
const chromeServerId = ${JSON.stringify(input.chromeServerId)};
const calls = [];
const textOf = (outcome) => outcome.content.filter((block) => block.type === "text").map((block) => block.text).join("\\n");
const locationOf = (snapshot, controlType) => {
  const line = snapshot.split(/\\r?\\n/).find((value) => value.toLowerCase().includes(controlType.toLowerCase()) && /\\(-?\\d+,\\s*-?\\d+\\)/.test(value));
  const match = /\\((-?\\d+),\\s*(-?\\d+)\\)/.exec(line ?? "");
  if (!match) throw new Error("semantic control location was absent");
  return [Number(match[1]), Number(match[2])];
};
const uidOf = (snapshot, role, name) => {
  const line = snapshot.split(/\\r?\\n/).find((value) => value.includes(" " + role + " \\"" + name + "\\""));
  const match = /uid=([^\\s]+)/.exec(line ?? "");
  if (!match) throw new Error("semantic page uid was absent for " + name);
  return match[1];
};
const call = async (serverId, toolName, arguments_) => {
  calls.push({ serverId, toolName });
  const outcome = await desktopMcp.call({ serverId, toolName, arguments: arguments_ });
  if (!outcome.ok || outcome.isError === true) throw new Error(serverId + "/" + toolName + " failed: " + (outcome.error ?? textOf(outcome)));
  return outcome;
};
let failure;
try {
${task}
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
console.log(${JSON.stringify(TRACE_PREFIX)} + JSON.stringify({ calls, ...(failure === undefined ? {} : { failure }) }));
if (failure !== undefined) process.exitCode = 1;
`;
}

function parseCodeTurnTrace(stdout: string): {
  calls: ToolTrace[];
  failure?: string;
} {
  const line = stdout
    .split(/\r?\n/)
    .findLast((value) => value.startsWith(TRACE_PREFIX));
  if (line === undefined) throw new Error("code-mode turn emitted no trace");
  const parsed: unknown = JSON.parse(line.slice(TRACE_PREFIX.length));
  assert(isRecord(parsed));
  const rawCalls = parsed["calls"];
  assert(Array.isArray(rawCalls), "code-mode trace has calls");
  const calls = rawCalls.map((value) => {
    assert(isRecord(value));
    const serverId = value["serverId"];
    const toolName = value["toolName"];
    assert(typeof serverId === "string" && typeof toolName === "string");
    return { serverId, toolName };
  });
  const failure = parsed["failure"];
  assert(failure === undefined || typeof failure === "string");
  return { calls, ...(failure === undefined ? {} : { failure }) };
}

async function invoke(
  input: SmokeInput,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const outcome = await callBroker(
    input.broker,
    "local_mcp",
    {
      operation: "call",
      serverId,
      toolName,
      arguments: args,
    },
    signal,
  );
  if (!outcome.ok || outcome.isError === true) {
    throw new Error(
      `${serverId}/${toolName} failed: ${outcome.error ?? textOf(outcome)}`,
    );
  }
  return outcome;
}

async function dismissDialog(input: SmokeInput): Promise<void> {
  try {
    await invoke(input, input.windowsServerId, "Shortcut", {
      shortcut: "esc",
    });
  } catch {
    // Cleanup must not replace the failure that led here.
  }
}

function textOf(outcome: ToolCallOutcome): string {
  const raw = outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  try {
    const value: unknown = JSON.parse(raw);
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      return value.join("\n");
    }
  } catch {
    // Most MCP text is already plain text.
  }
  return raw;
}

function searchToolNames(outcome: ToolCallOutcome): string[] {
  const matches = outcome.structuredContent?.["matches"];
  assert(Array.isArray(matches), "search returns structured matches");
  return matches
    .map((match) => {
      assert(isRecord(match));
      const name = match["toolName"];
      if (typeof name !== "string") {
        throw new Error("search match has no tool name");
      }
      return name;
    })
    .sort();
}

function elementLocation(
  snapshot: string,
  windowName: string,
  controlType: string,
  elementName?: string,
): number[] {
  const namePattern =
    elementName === undefined ? '[^"]*' : escapeRegExp(elementName);
  const match = new RegExp(
    `\\((-?\\d+),\\s*(-?\\d+)\\)\\s+${escapeRegExp(controlType)}\\s+"${namePattern}"`,
    "i",
  ).exec(snapshot);
  if (!match) {
    const evidence = snapshot
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.toLowerCase().includes(windowName.toLowerCase()) ||
          (elementName !== undefined &&
            line.toLowerCase().includes(elementName.toLowerCase())),
      )
      .join(" | ");
    throw new Error(
      `${controlType} ${elementName ?? "element"} was absent from ${windowName}: ${evidence}`,
    );
  }
  return [Number(match[1]), Number(match[2])];
}

function chromeUid(
  snapshot: string,
  role: string,
  accessibleName: string,
): string {
  const match = new RegExp(
    `uid=([^\\s]+)\\s+${escapeRegExp(role)}\\s+"${escapeRegExp(accessibleName)}"`,
    "i",
  ).exec(snapshot);
  assert(match, `Chrome snapshot contains ${accessibleName}`);
  const uid = match[1];
  assert(uid);
  return uid;
}

function inspectOwnedServers(appPid: number): ProcessRecord[] {
  const command = [
    `$rootPid = ${appPid}`,
    "$all = @(Get-CimInstance Win32_Process)",
    "$ids = @($rootPid)",
    "do { $next = @($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while ($next.Count -gt 0)",
    "$current = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())",
    "$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    '$processes = @($all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { $ownerResult = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; [pscustomobject]@{ processId = [int]$_.ProcessId; commandLine = [string]$_.CommandLine; owner = if ($ownerResult.Domain) { "$($ownerResult.Domain)\\$($ownerResult.User)" } else { [string]$ownerResult.User } } })',
    "[pscustomobject]@{ currentUser = $current; elevated = $elevated; processes = $processes } | ConvertTo-Json -Depth 4 -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || "process ownership query failed",
  );
  const parsed: unknown = JSON.parse(result.stdout);
  assert(isRecord(parsed));
  assert.equal(
    parsed["elevated"],
    false,
    "run the smoke as an unelevated user",
  );
  const currentUser = parsed["currentUser"];
  if (typeof currentUser !== "string") {
    throw new Error("process ownership query has no current user");
  }
  const rawProcesses = parsed["processes"];
  const values = Array.isArray(rawProcesses) ? rawProcesses : [rawProcesses];
  const processes = values.map(parseProcessRecord);
  const servers = processes.filter((process) =>
    /chrome-devtools-mcp|windows-mcp|launch\.py/i.test(process.commandLine),
  );
  assert(
    servers.some((process) => /chrome-devtools-mcp/i.test(process.commandLine)),
    "Chrome DevTools MCP is an app descendant",
  );
  assert(
    servers.some((process) =>
      /windows-mcp|launch\.py/i.test(process.commandLine),
    ),
    "Windows-MCP is an app descendant",
  );
  for (const process of servers) {
    assert.equal(process.owner.toLowerCase(), currentUser.toLowerCase());
  }
  return servers;
}

function parseProcessRecord(value: unknown): ProcessRecord {
  assert(isRecord(value));
  const commandLine = value["commandLine"];
  const owner = value["owner"];
  const processId = value["processId"];
  if (
    typeof commandLine !== "string" ||
    typeof owner !== "string" ||
    typeof processId !== "number"
  ) {
    throw new Error("process ownership query returned an invalid process");
  }
  return { commandLine, owner, processId };
}

function serverProcessIds(processes: ProcessRecord[]): number[] {
  return processes.map((process) => process.processId).sort((a, b) => a - b);
}

function median(values: number[]): number {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  assert(value !== undefined);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type BrowserFixture = {
  close(): Promise<void>;
  submissions: Set<string>;
  url: string;
};

async function startBrowserFixture(): Promise<BrowserFixture> {
  const submissions = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/saved") {
      submissions.add(url.searchParams.get("value") ?? "");
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sandi computer-use fixture</title>
<style>body{font:20px system-ui;margin:80px}label,input,button{display:block;margin:18px 0}input{width:360px;padding:12px}button{padding:12px 28px}</style></head>
 <body><h1>Sandi computer-use fixture</h1><label>Name<input aria-label="Name" id="name"></label>
 <button id="save">Save</button>
 <output id="status" aria-live="polite"></output><script>
 document.querySelector("#save").addEventListener("click",async()=>{const value=document.querySelector("#name").value;await fetch("/saved?value="+encodeURIComponent(value));document.querySelector("#status").textContent="Saved "+value;});
</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
    submissions,
    url: `http://127.0.0.1:${address.port}/`,
  };
}
