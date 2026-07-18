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
  await writeFile(checker, "", "utf8");
  await writeFile(
    runtime,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const artifact = process.argv.at(-1);",
      'if (!artifact) throw new Error("artifact missing");',
      'const source = readFileSync(artifact, "utf8");',
      'if (source.includes("Cancel target")) {',
      '  writeFileSync(process.env.SANDI_NATIVE_STARTED, "started");',
      "  setInterval(() => {}, 1000);",
      '} else if (source.includes("Ambiguous target")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"error","action":"invoke","error":{"code":"ambiguity","facadeCode":5,"extended":2}}\');',
      "  process.exit(10);",
      '} else if (source.includes("Malformed inspection")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"inspect","data":{"unexpected":true}}\');',
      '} else if (source.includes("SandiUIA_Inspect")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"inspect","data":{"root":{"pid":101,"hwnd":4242},"elements":[{"identity":{"automationId":"TextEditor","controlType":50004,"name":"Text editor","className":"RichEditD2DPT","path":"0/1"},"actions":["GetValue","SetValue"]}]}}\');',
      '} else if (source.includes("SandiUIA_Describe")) {',
      '  console.log(\'SANDI_NATIVE_RESULT:{"status":"ok","action":"describe","data":{"summary":"Edit control"}}\');',
      '} else if (source.includes("SandiEditor_InsertText")) {',
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
      env: { SANDI_NATIVE_STARTED: started },
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
  const payloadPath = findPayloadPath(root);
  assert.equal(
    await readFile(payloadPath, "utf8"),
    payload,
    "the generated runtime receives the exact multiline payload",
  );

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

  const controller = new AbortController();
  const cancelledCall = runLocalNative(
    {
      action: "invoke",
      target: { ...retainedEditor, name: "Cancel target" },
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
}

function findPayloadPath(root: string): string {
  const runs = join(root, "runs");
  for (const entry of readdirSync(runs)) {
    const payload = join(runs, entry, "payload.txt");
    if (existsSync(payload)) return payload;
  }
  throw new Error("generated AutoIt payload is missing");
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
