import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withTempDir } from "@/lib/verification/harness";
import type { LocalScriptRuntimeContext } from "@/surfaces/api/client/local-script-runtimes";
import {
  generateNativeAutoIt,
  runLocalNative,
} from "@/surfaces/api/client/native-automation";
import {
  type ActionReceipt,
  formatActionReceipt,
  MAX_NATIVE_CONTROL_PATH_CHARS,
  parseActionReceipt,
} from "@/surfaces/api/devices/action-receipt";
import {
  LocalNativeParamsSchema,
  type ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";

const retainedEditor = {
  hwnd: "4242",
  pid: 101,
  automationId: "TextEditor",
  controlType: 50004,
  name: "Text editor",
  className: "RichEditD2DPT",
  path: "0/1",
};

await withTempDir("sandi-native-automation-", async (root) => {
  verifySchemas();
  verifyGeneratedSources();
  await verifyStructuredResults(root);
});
console.log("native automation verification passed");

function verifySchemas(): void {
  assert(
    LocalNativeParamsSchema.safeParse({
      action: "invoke",
      target: retainedEditor,
    }).success,
    "a mutation accepts a complete retained control identity",
  );
  assert(
    !LocalNativeParamsSchema.safeParse({
      action: "invoke",
      target: { hwnd: "4242", pid: 101, name: "Save" },
    }).success,
    "a mutation rejects a partial control identity",
  );
  assert(
    !LocalNativeParamsSchema.safeParse({
      action: "visual_click",
      visualObservation: { version: 2, target: { hwnd: "4242", pid: 101 } },
      x: 0.5,
      y: 0.5,
    }).success,
    "a visual mutation rejects an incomplete observation",
  );
  assert(
    !LocalNativeParamsSchema.safeParse({
      action: "wait_value",
      target: retainedEditor,
      value: "ready",
      timeoutMs: 30_001,
    }).success,
    "native waits reject an unbounded timeout",
  );
  assert(
    !LocalNativeParamsSchema.safeParse({
      action: "inspect",
      window: { hwnd: "0", pid: 101 },
    }).success,
    "native identities reject the null HWND",
  );
  const longestPath = `10/${Array.from(
    { length: (MAX_NATIVE_CONTROL_PATH_CHARS - 2) / 2 },
    () => "0",
  ).join("/")}`;
  assert.equal(longestPath.length, MAX_NATIVE_CONTROL_PATH_CHARS);
  assert(
    LocalNativeParamsSchema.safeParse({
      action: "invoke",
      target: { ...retainedEditor, path: longestPath },
    }).success,
    "native requests accept the full retained identity path bound",
  );
  assert(
    !LocalNativeParamsSchema.safeParse({
      action: "invoke",
      target: { ...retainedEditor, path: `${longestPath}/0` },
    }).success,
    "native requests reject paths beyond the receipt identity bound",
  );
}

function verifyGeneratedSources(): void {
  const text = 'first line\nsecond line with "quotes"';
  const insert = generateNativeAutoIt({
    action: "insert_text",
    target: retainedEditor,
    text,
  });
  assert.equal(
    insert.payload,
    text,
    "editor text stays in the companion payload",
  );
  assert(
    !insert.code.includes(text),
    "editor text is not interpolated into AutoIt source",
  );
  assert.match(insert.code, /SandiEditor_InsertText/);
  assert.match(insert.code, /HWnd\("4242"\), 101/);
  assert.match(insert.code, /"TextEditor", 50004, "Text editor"/);
  assert.match(insert.code, /"RichEditD2DPT", "0\/1"/);

  const setValue = generateNativeAutoIt({
    action: "set_value",
    target: retainedEditor,
    value: text,
  });
  assert.match(setValue.code, /SandiUIA_SetValue/);
  assert.match(setValue.code, /SandiUIA_GetValue/);
  assert.match(setValue.code, /verification_failure/);

  const capturedAtMs = Date.now();
  const visual = generateNativeAutoIt({
    action: "visual_click",
    visualObservation: {
      version: 2,
      capturedAtMs,
      target: { hwnd: "4242", pid: 101 },
      active: true,
      clientRect: { x: 0, y: 0, width: 800, height: 600 },
      clientOriginScreen: { x: 50, y: 80 },
      dpi: 96,
      screenshot: { width: 400, height: 300, scaleX: 0.5, scaleY: 0.5 },
    },
    x: 0.25,
    y: 0.75,
  });
  assert.match(visual.code, new RegExp(String(capturedAtMs)));
  assert(
    visual.code.indexOf("_SandiNativeUnixTimeMs()") <
      visual.code.indexOf("SandiVisual_Click"),
    "visual freshness is checked inside the artifact before mutation",
  );
  assert.match(visual.code, /SandiVisual_Click/);
  assert(!/\b(?:Run|ShellExecute|RegWrite)\s*\(/i.test(visual.code));
}

async function verifyStructuredResults(root: string): Promise<void> {
  const checker = join(root, "checker.mjs");
  const runtime = join(root, "runtime.mjs");
  const started = join(root, "started.txt");
  const payloadCapture = join(root, "payload-capture.txt");
  await writeFile(
    checker,
    [
      'import { readFileSync } from "node:fs";',
      "const artifact = process.argv.at(-1);",
      'if (!artifact) throw new Error("artifact missing");',
      'if (readFileSync(artifact, "utf8").includes("Checker failure")) process.exit(2);',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    runtime,
    [
      'import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      "const artifact = process.argv.at(-1);",
      'if (!artifact) throw new Error("artifact missing");',
      'const source = readFileSync(artifact, "utf8");',
      'if (source.includes("Cancel target")) {',
      '  writeFileSync(process.env.SANDI_NATIVE_PAYLOAD_CAPTURE, readFileSync(join(dirname(artifact), "payload.txt"), "utf8"));',
      '  writeFileSync(process.env.SANDI_NATIVE_STARTED, "started");',
      "  setInterval(() => {}, 1000);",
      '} else if (source.includes("Cleanup failure")) {',
      '  const payload = join(dirname(artifact), "payload.txt");',
      "  rmSync(payload);",
      "  mkdirSync(payload);",
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"insert_text","data":{"mutated":true,"preActionTarget":"revalidated","verification":"observe_next","submitted":false}}\');',
      '} else if (source.includes("Ambiguous target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"invoke","error":{"code":"ambiguity","facadeCode":5,"extended":2}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Missing target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"invoke","error":{"code":"no_match","facadeCode":4,"extended":0}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Unsupported target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"toggle","error":{"code":"unsupported_pattern","facadeCode":6,"extended":0}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Timed out target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"insert_text","error":{"code":"timeout","facadeCode":0,"extended":0}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Verification mismatch")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"set_value","error":{"code":"verification_failure","facadeCode":0,"extended":0}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Execution failure target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"invoke","error":{"code":"execution_failure","facadeCode":9,"extended":0}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Malformed inspection")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"inspect","data":{"unexpected":true}}\');',
      '} else if (source.includes("No marker target")) {',
      "  process.exit(9);",
      '} else if (source.includes("SandiUIA_Inspect")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"inspect","data":{"root":{"pid":101,"hwnd":4242},"elements":[{"identity":{"automationId":"TextEditor","controlType":50004,"name":"Text editor","className":"RichEditD2DPT","path":"0/1"},"actions":["GetValue","SetValue"]}]}}\');',
      '} else if (source.includes("SandiUIA_Describe")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"describe","data":{"summary":"Edit control"}}\');',
      '} else if (source.includes("SandiUIA_SetValue")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"set_value","data":{"mutated":true,"verification":"verified"}}\');',
      '} else if (source.includes("SandiEditor_InsertText")) {',
      '  writeFileSync(process.env.SANDI_NATIVE_PAYLOAD_CAPTURE, readFileSync(join(dirname(artifact), "payload.txt"), "utf8"));',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"insert_text","data":{"mutated":true,"preActionTarget":"revalidated","verification":"observe_next","submitted":false}}\');',
      "} else {",
      '  const actions = [...source.matchAll(/_SandiNativeOk\\("([a-z_]+)"/g)];',
      '  const action = actions.at(-1)?.[1] ?? "unknown";',
      '  console.log("SANDI_NATIVE_RESULT:" + JSON.stringify({ status: "ok", action, data: { mutated: true, verification: "observe_next" } }));',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const context: LocalScriptRuntimeContext = {
    runRoot: join(root, "runs"),
    javascript: {
      executable: process.execPath,
      version: process.versions.node,
    },
    autoit: {
      executable: process.execPath,
      version: "fixture",
      argsPrefix: [runtime],
      env: {
        SANDI_NATIVE_STARTED: started,
        SANDI_NATIVE_PAYLOAD_CAPTURE: payloadCapture,
      },
      checker: { executable: process.execPath, argsPrefix: [checker] },
    },
  };

  const inspected = await runLocalNative(
    {
      action: "inspect",
      window: { hwnd: "4242", pid: 101 },
    },
    root,
    context,
  );
  assert.equal(inspected.ok, true);
  assert.equal(inspected.isError, undefined);
  const inspection = inspected.structuredContent?.["nativeAutomation"];
  assert.deepEqual(inspection, {
    version: 1,
    action: "inspect",
    status: "ok",
    data: {
      root: { hwnd: "4242", pid: 101 },
      elements: [
        {
          identity: retainedEditor,
          actions: ["GetValue", "SetValue"],
        },
      ],
    },
  });

  const malformedInspection = await runLocalNative(
    {
      action: "inspect",
      window: { hwnd: "4242", pid: 101 },
      filters: { name: "Malformed inspection" },
    },
    root,
    context,
  );
  assert.equal(
    nativeErrorCode(malformedInspection),
    "execution_failure",
    "malformed inspection JSON fails closed",
  );

  const described = await runLocalNative(
    { action: "describe", target: retainedEditor },
    root,
    context,
  );
  assert.deepEqual(
    nativeData(described),
    { summary: "Edit control" },
    "describe returns a typed object",
  );

  const payload = "Ada Lovelace\nGrace Hopper";
  const inserted = await runLocalNative(
    { action: "insert_text", target: retainedEditor, text: payload },
    root,
    context,
  );
  assert.equal(inserted.isError, undefined);
  const insertedReceipt = actionReceipt(inserted);
  assert.equal(insertedReceipt.action, "insert-text");
  assert.deepEqual(insertedReceipt.execution, {
    status: "completed",
    result: { status: "succeeded" },
  });
  assert.deepEqual(insertedReceipt.verification, {
    status: "not-performed",
    reason: "caller-observation-required",
  });
  assert.deepEqual(insertedReceipt.cleanup, { status: "succeeded" });
  assert.equal(textContent(inserted), formatActionReceipt(insertedReceipt));
  assert.equal(
    await readFile(payloadCapture, "utf8"),
    payload,
    "the generated runtime receives the exact multiline payload",
  );
  assert.deepEqual(
    findPayloadPaths(root),
    [],
    "the companion payload is deleted after success",
  );
  assert(
    findSourcePaths(root).length > 0,
    "payload cleanup preserves the generated source artifact",
  );

  const setValue = await runLocalNative(
    { action: "set_value", target: retainedEditor, value: "Ada" },
    root,
    context,
  );
  const setReceipt = actionReceipt(setValue);
  assert.deepEqual(setReceipt.execution, {
    status: "completed",
    result: { status: "succeeded" },
  });
  assert.equal(setReceipt.verification.status, "succeeded");

  const invoked = await runLocalNative(
    { action: "invoke", target: retainedEditor },
    root,
    context,
  );
  const invokeReceipt = actionReceipt(invoked);
  assert.deepEqual(invokeReceipt.execution, {
    status: "completed",
    result: { status: "succeeded" },
  });
  assert.deepEqual(invokeReceipt.verification, {
    status: "not-performed",
    reason: "caller-observation-required",
  });

  for (const action of ["toggle", "select"] as const) {
    const outcome = await runLocalNative(
      { action, target: retainedEditor },
      root,
      context,
    );
    assert.deepEqual(actionReceipt(outcome).execution, {
      status: "completed",
      result: { status: "succeeded" },
    });
    assert.deepEqual(actionReceipt(outcome).verification, {
      status: "not-performed",
      reason: "caller-observation-required",
    });
  }

  const visualClicked = await runLocalNative(
    {
      action: "visual_click",
      visualObservation: {
        version: 2,
        capturedAtMs: Date.now(),
        target: { hwnd: "4242", pid: 101 },
        active: true,
        clientRect: { x: 0, y: 0, width: 800, height: 600 },
        clientOriginScreen: { x: 50, y: 80 },
        dpi: 96,
        screenshot: {
          width: 400,
          height: 300,
          scaleX: 0.5,
          scaleY: 0.5,
        },
      },
      x: 0.25,
      y: 0.75,
    },
    root,
    context,
  );
  const visualReceipt = actionReceipt(visualClicked);
  assert.equal(visualReceipt.action, "visual-click");
  assert.equal(visualReceipt.target.control, undefined);
  assert.deepEqual(visualReceipt.execution, {
    status: "completed",
    result: { status: "succeeded" },
  });

  const ambiguous = await runLocalNative(
    {
      action: "invoke",
      target: { ...retainedEditor, name: "Ambiguous target" },
    },
    root,
    context,
  );
  assert.equal(ambiguous.isError, true);
  assert.equal(
    nativeErrorCode(ambiguous),
    "ambiguity",
    "facade ambiguity remains a structured tool error",
  );
  assert.deepEqual(actionReceipt(ambiguous).execution, {
    status: "not-started",
    reason: "ambiguous-target",
  });
  assert.equal(actionReceipt(ambiguous).observation.status, "fresh");

  const missing = await runLocalNative(
    {
      action: "invoke",
      target: { ...retainedEditor, name: "Missing target" },
    },
    root,
    context,
  );
  assert.deepEqual(actionReceipt(missing).execution, {
    status: "not-started",
    reason: "refused",
  });
  assert.equal(actionReceipt(missing).observation.status, "stale");

  const unsupported = await runLocalNative(
    {
      action: "toggle",
      target: { ...retainedEditor, name: "Unsupported target" },
    },
    root,
    context,
  );
  assert.deepEqual(actionReceipt(unsupported).execution, {
    status: "not-started",
    reason: "unsupported",
  });

  const staleVisual = await runLocalNative(
    {
      action: "visual_click",
      visualObservation: {
        version: 2,
        capturedAtMs: 0,
        target: { hwnd: "4242", pid: 101 },
        active: true,
        clientRect: { x: 0, y: 0, width: 800, height: 600 },
        clientOriginScreen: { x: 50, y: 80 },
        dpi: 96,
        screenshot: {
          width: 400,
          height: 300,
          scaleX: 0.5,
          scaleY: 0.5,
        },
      },
      x: 0.25,
      y: 0.75,
    },
    root,
    context,
  );
  assert.equal(nativeErrorCode(staleVisual), "stale_target");
  assert.deepEqual(actionReceipt(staleVisual).execution, {
    status: "not-started",
    reason: "stale-target",
  });

  const mismatched = await runLocalNative(
    {
      action: "set_value",
      target: { ...retainedEditor, name: "Verification mismatch" },
      value: "Ada",
    },
    root,
    context,
  );
  const mismatchReceipt = actionReceipt(mismatched);
  assert.deepEqual(mismatchReceipt.execution, {
    status: "completed",
    result: { status: "succeeded" },
  });
  assert.deepEqual(mismatchReceipt.verification, {
    status: "failed",
    reason: "state-mismatch",
  });

  const timedOut = await runLocalNative(
    {
      action: "insert_text",
      target: { ...retainedEditor, name: "Timed out target" },
      text: "Ada",
    },
    root,
    context,
  );
  assert.deepEqual(actionReceipt(timedOut).execution, {
    status: "unknown",
    reason: "timed-out",
    next: "observe",
  });
  assert.equal(actionReceipt(timedOut).observation.status, "unavailable");

  const noMarker = await runLocalNative(
    {
      action: "invoke",
      target: { ...retainedEditor, name: "No marker target" },
    },
    root,
    context,
  );
  assert.deepEqual(actionReceipt(noMarker).execution, {
    status: "unknown",
    reason: "transport-failure",
    next: "observe",
  });
  assert.equal(actionReceipt(noMarker).observation.status, "unavailable");

  const genericFailure = await runLocalNative(
    {
      action: "invoke",
      target: { ...retainedEditor, name: "Execution failure target" },
    },
    root,
    context,
  );
  assert.deepEqual(actionReceipt(genericFailure).execution, {
    status: "unknown",
    reason: "transport-failure",
    next: "observe",
  });

  const controller = new AbortController();
  const cancelledCall = runLocalNative(
    {
      action: "insert_text",
      target: { ...retainedEditor, name: "Cancel target" },
      text: "cancelled payload",
    },
    root,
    context,
    controller.signal,
  );
  await waitUntil(() => existsSync(started), "fixture native process");
  controller.abort();
  const cancelled = await cancelledCall;
  assert.equal(cancelled.isError, true);
  assert.equal(nativeErrorCode(cancelled), "cancelled");
  assert.deepEqual(actionReceipt(cancelled).execution, {
    status: "unknown",
    reason: "cancelled",
    next: "observe",
  });
  assert.deepEqual(actionReceipt(cancelled).verification, {
    status: "not-performed",
    reason: "interrupted",
  });
  assert.equal(actionReceipt(cancelled).observation.status, "unavailable");
  assert.deepEqual(
    findPayloadPaths(root),
    [],
    "the companion payload is deleted after cancellation",
  );

  const checkerFailure = await runLocalNative(
    {
      action: "insert_text",
      target: { ...retainedEditor, name: "Checker failure" },
      text: "checker payload",
    },
    root,
    context,
  );
  assert.equal(nativeErrorCode(checkerFailure), "execution_failure");
  assert.deepEqual(actionReceipt(checkerFailure).execution, {
    status: "not-started",
    reason: "refused",
  });
  assert.equal(actionReceipt(checkerFailure).observation.status, "unavailable");
  assert.deepEqual(
    findPayloadPaths(root),
    [],
    "the companion payload is deleted after checker failure",
  );

  const cleanupFailure = await runLocalNative(
    {
      action: "insert_text",
      target: { ...retainedEditor, name: "Cleanup failure" },
      text: "cleanup payload",
    },
    root,
    context,
  );
  assert.equal(cleanupFailure.isError, true);
  assert.equal(
    actionReceipt(cleanupFailure).execution.status,
    "completed",
    "the action marker survives a companion cleanup failure",
  );
  assert.deepEqual(actionReceipt(cleanupFailure).cleanup, {
    status: "failed",
    reason: "process-cleanup",
  });

  const unavailable = await runLocalNative(
    { action: "invoke", target: retainedEditor },
    root,
    { runRoot: context.runRoot, javascript: context.javascript },
  );
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error ?? "", /runtime is unavailable/);
}

function findPayloadPaths(root: string): string[] {
  const runs = join(root, "runs");
  const paths: string[] = [];
  for (const entry of readdirSync(runs)) {
    const payload = join(runs, entry, "payload.txt");
    if (existsSync(payload)) paths.push(payload);
  }
  return paths;
}

function findSourcePaths(root: string): string[] {
  const runs = join(root, "runs");
  return readdirSync(runs)
    .map((entry) => join(runs, entry, "main.au3"))
    .filter((path) => existsSync(path));
}

function nativeErrorCode(outcome: ToolCallOutcome): unknown {
  const native = outcome.structuredContent?.["nativeAutomation"];
  if (typeof native !== "object" || native === null) return undefined;
  const error = Reflect.get(native, "error");
  if (typeof error !== "object" || error === null) return undefined;
  return Reflect.get(error, "code");
}

function nativeData(outcome: ToolCallOutcome): unknown {
  const native = outcome.structuredContent?.["nativeAutomation"];
  if (typeof native !== "object" || native === null) return undefined;
  return Reflect.get(native, "data");
}

function actionReceipt(outcome: ToolCallOutcome): ActionReceipt {
  return parseActionReceipt(outcome.structuredContent?.["actionReceipt"]);
}

function textContent(outcome: ToolCallOutcome): string {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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
