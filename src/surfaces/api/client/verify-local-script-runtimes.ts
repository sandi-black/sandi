import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  autoItRequiresAdmin,
  type LocalScriptRuntimeContext,
  runGeneratedAutoIt,
  runLocalAutoIt,
  runLocalJavaScript,
} from "@/surfaces/api/client/local-script-runtimes";
import {
  ACTION_RECEIPT_STDOUT_PREFIX,
  buildActionReceipt,
} from "@/surfaces/api/devices/action-receipt";

const root = mkdtempSync(join(tmpdir(), "sandi-local-script-runtime-"));
const context: LocalScriptRuntimeContext = {
  runRoot: join(root, "runs"),
  javascript: {
    executable: process.execPath,
    version: process.versions.node,
  },
};

try {
  const success = await runLocalJavaScript(
    { code: 'console.log("Grace Hopper")' },
    root,
    context,
  );
  assert.equal(success.ok, true);
  assert.equal(success.isError, undefined);
  assert.match(text(success), /Grace Hopper/);
  assert.equal(success.structuredContent?.["runtime"], "node");
  assert.equal(success.structuredContent?.["exitCode"], 0);
  assert.equal(success.structuredContent?.["elevated"], false);
  const artifact = success.structuredContent?.["artifactPath"];
  assert.equal(typeof artifact, "string");
  assert(
    existsSync(String(artifact)),
    "the unique JavaScript artifact remains available",
  );

  const syntax = await runLocalJavaScript(
    { code: "const = broken" },
    root,
    context,
  );
  assert.equal(syntax.ok, true);
  assert.equal(syntax.isError, true);
  assert.notEqual(syntax.structuredContent?.["exitCode"], 0);
  assert.match(text(syntax), /untrusted_process_output/);

  const truncated = await runLocalJavaScript(
    {
      code: 'console.log("x".repeat(50000)); console.error("y".repeat(50000))',
    },
    root,
    context,
  );
  assert.equal(truncated.structuredContent?.["truncated"], true);
  assert(
    text(truncated).length < 90_000,
    "captured output stays below the wire limit",
  );

  const nested = join(root, "Ada workspace");
  mkdirSync(nested);
  const cwd = await runLocalJavaScript(
    { code: "console.log(process.cwd())", cwd: nested },
    root,
    context,
  );
  assert.equal(cwd.ok, true);
  assert.match(text(cwd), /Ada workspace/);
  const missingCwd = await runLocalJavaScript(
    { code: "console.log('must not run')", cwd: join(root, "missing") },
    root,
    context,
  );
  assert.equal(missingCwd.ok, false, "a missing working directory is refused");

  const timeout = await runLocalJavaScript(
    { code: "setInterval(() => {}, 1000)", timeoutMs: 100 },
    root,
    context,
  );
  assert.equal(timeout.isError, true);
  assert.equal(timeout.structuredContent?.["timedOut"], true);

  const marker = join(root, "active.marker");
  const controller = new AbortController();
  const active = runLocalJavaScript(
    {
      code: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "active"); setInterval(() => {}, 1000);`,
    },
    root,
    context,
    controller.signal,
  );
  await waitUntil(() => existsSync(marker), "active JavaScript marker");
  controller.abort(new Error("cancelled by verification"));
  const cancelled = await active;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, "cancelled");

  const tree = await runLocalJavaScript(
    {
      code: [
        'import { spawn } from "node:child_process";',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'console.log("child=" + child.pid);',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      timeoutMs: 200,
    },
    root,
    context,
  );
  const childPid = Number(/child=(\d+)/.exec(text(tree))?.[1]);
  assert(
    Number.isSafeInteger(childPid) && childPid > 0,
    "the child pid is captured",
  );
  await waitUntil(
    () => !isProcessRunning(childPid),
    "script descendant cleanup",
  );

  const unavailable = await runLocalAutoIt(
    { code: 'ConsoleWrite("Ada")' },
    root,
    context,
  );
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error ?? "", /unavailable/);
  const corruptRuntime = await runLocalAutoIt(
    { code: 'ConsoleWrite("Ada")' },
    root,
    {
      ...context,
      autoit: async () => {
        throw new Error("AutoIt3_x64.exe failed verification");
      },
    },
  );
  assert.equal(corruptRuntime.ok, false);
  assert.match(corruptRuntime.error ?? "", /failed verification/);
  const autoitLog = join(root, "autoit-fixture.log");
  const autoitCheckerFixture = join(root, "autoit-checker-fixture.mjs");
  const autoitRuntimeFixture = join(root, "autoit-runtime-fixture.mjs");
  writeFileSync(
    autoitCheckerFixture,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const artifact = process.argv.at(-1);",
      'if (!artifact) throw new Error("artifact is required");',
      'const source = readFileSync(artifact, "utf8");',
      'appendFileSync(process.env.SANDI_AUTOIT_FIXTURE_LOG, "checked\\n");',
      'if (source.includes("CHECK_HANG")) setInterval(() => {}, 1000);',
      'if (source.includes("CHECK_WARNING")) { console.error("fixture warning"); process.exit(1); }',
      'if (source.includes("CHECK_ERROR")) { console.error("fixture syntax error"); process.exit(2); }',
      "",
    ].join("\n"),
  );
  writeFileSync(
    autoitRuntimeFixture,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'appendFileSync(process.env.SANDI_AUTOIT_FIXTURE_LOG, "ran\\n");',
      "const artifact = process.argv.at(-1);",
      'if (!artifact) throw new Error("artifact missing");',
      'const source = readFileSync(artifact, "utf8");',
      "const receipt = /^; EMIT_RECEIPT (.+)$/m.exec(source)?.[1];",
      "if (receipt) console.log(receipt);",
      'if (source.includes("RUN_HANG")) setInterval(() => {}, 1000);',
      'console.log("fixture AutoIt executed");',
      "",
    ].join("\n"),
  );
  const autoitContext: LocalScriptRuntimeContext = {
    ...context,
    autoit: {
      executable: process.execPath,
      version: "fixture",
      argsPrefix: [autoitRuntimeFixture],
      env: { SANDI_AUTOIT_FIXTURE_LOG: autoitLog },
      checker: {
        executable: process.execPath,
        argsPrefix: [autoitCheckerFixture],
      },
    },
  };
  const checkedAutoIt = await runLocalAutoIt(
    { code: 'ConsoleWrite("Grace Hopper")' },
    root,
    autoitContext,
  );
  assert.equal(checkedAutoIt.isError, undefined);
  assert.equal(checkedAutoIt.structuredContent?.["phase"], "execution");
  assert.equal(checkedAutoIt.structuredContent?.["syntaxCheck"], "passed");
  assert.deepEqual(readFileSync(autoitLog, "utf8").trim().split(/\r?\n/), [
    "checked",
    "ran",
  ]);
  const actionReceipt = buildActionReceipt({
    action: "set-value",
    method: "uia-value-pattern",
    target: {
      pid: 1234,
      hwnd: "5678",
      control: { kind: "uia-path", path: "0/2" },
    },
    observation: {
      status: "fresh",
      observedAt: "2026-07-18T18:00:00.000Z",
    },
    execution: { status: "completed", result: { status: "succeeded" } },
    verification: {
      status: "succeeded",
      basis: "post-action",
      observedAt: "2026-07-18T18:00:01.000Z",
    },
    cleanup: { status: "not-required" },
  });
  const receiptedAutoIt = await runLocalAutoIt(
    {
      code: `; EMIT_RECEIPT ${ACTION_RECEIPT_STDOUT_PREFIX}${JSON.stringify(actionReceipt)}\nConsoleWrite("ordinary output")`,
    },
    root,
    autoitContext,
  );
  assert.equal(receiptedAutoIt.ok, true);
  assert.equal(receiptedAutoIt.isError, undefined);
  assert.deepEqual(
    receiptedAutoIt.structuredContent?.["actionReceipt"],
    actionReceipt,
  );
  assert.doesNotMatch(text(receiptedAutoIt), /SANDI_ACTION_RECEIPT:/);
  assert.match(text(receiptedAutoIt), /set-value via uia-value-pattern/);
  assert.match(text(receiptedAutoIt), /fixture AutoIt executed/);

  const malformedReceipt = await runLocalAutoIt(
    {
      code: `; EMIT_RECEIPT ${ACTION_RECEIPT_STDOUT_PREFIX}{\nConsoleWrite("ordinary output")`,
    },
    root,
    autoitContext,
  );
  assert.equal(malformedReceipt.ok, true);
  assert.equal(malformedReceipt.isError, true);
  assert.equal(
    malformedReceipt.structuredContent?.["actionReceiptError"],
    "AutoIt emitted malformed action receipt JSON",
  );
  assert.doesNotMatch(text(malformedReceipt), /SANDI_ACTION_RECEIPT:/);
  const unfilteredAutoIt = await runLocalAutoIt(
    {
      code: [
        'Send("Grace Hopper")',
        "MouseMove(10, 10)",
        'Call("DynamicFunction")',
        "Execute('ConsoleWrite(\"dynamic\")')",
        'Eval("dynamicVariable")',
        'DllCall("kernel32.dll", "none", "Sleep", "dword", 0)',
        'DllCallAddress("none", 0)',
      ].join("\n"),
    },
    root,
    autoitContext,
  );
  assert.equal(unfilteredAutoIt.ok, true);
  assert.equal(unfilteredAutoIt.isError, undefined);

  writeFileSync(autoitLog, "", "utf8");
  const invalidAutoIt = await runLocalAutoIt(
    { code: '; CHECK_ERROR\nConsoleWrite("must not run")' },
    root,
    autoitContext,
  );
  assert.equal(invalidAutoIt.isError, true);
  assert.equal(invalidAutoIt.structuredContent?.["phase"], "syntax_check");
  assert.equal(invalidAutoIt.structuredContent?.["syntaxCheck"], "failed");
  assert.equal(readFileSync(autoitLog, "utf8").trim(), "checked");
  assert.match(text(invalidAutoIt), /fixture syntax error/);
  assert.match(text(invalidAutoIt), /untrusted_process_output/);

  writeFileSync(autoitLog, "", "utf8");
  const warnedAutoIt = await runLocalAutoIt(
    { code: '; CHECK_WARNING\nConsoleWrite("Anna Winlock")' },
    root,
    autoitContext,
  );
  assert.equal(warnedAutoIt.isError, undefined);
  assert.equal(warnedAutoIt.structuredContent?.["syntaxCheck"], "warnings");
  assert.match(text(warnedAutoIt), /fixture warning/);
  assert.deepEqual(readFileSync(autoitLog, "utf8").trim().split(/\r?\n/), [
    "checked",
    "ran",
  ]);

  const generatedTimeout = await runGeneratedAutoIt(
    {
      code: "; RUN_HANG\nConsoleWrite('must time out')",
      files: { "payload.txt": "Grace Hopper private draft" },
      timeoutMs: 100,
    },
    root,
    autoitContext,
  );
  assert.equal(generatedTimeout.structuredContent?.["timedOut"], true);
  const generatedArtifact =
    generatedTimeout.structuredContent?.["artifactPath"];
  assert.equal(typeof generatedArtifact, "string");
  assert(
    existsSync(String(generatedArtifact)),
    "generated source persists after timeout",
  );
  assert(
    !existsSync(join(dirname(String(generatedArtifact)), "payload.txt")),
    "generated companion payload is deleted after timeout",
  );

  writeFileSync(autoitLog, "", "utf8");
  const checkerController = new AbortController();
  const checkingAutoIt = runLocalAutoIt(
    { code: '; CHECK_HANG\nConsoleWrite("must not run")' },
    root,
    autoitContext,
    checkerController.signal,
  );
  await waitUntil(
    () => readFileSync(autoitLog, "utf8").includes("checked"),
    "active AutoIt syntax checker",
  );
  checkerController.abort();
  const cancelledAutoIt = await checkingAutoIt;
  assert.equal(cancelledAutoIt.ok, false);
  assert.equal(cancelledAutoIt.error, "cancelled");
  assert.equal(readFileSync(autoitLog, "utf8").trim(), "checked");

  writeFileSync(autoitLog, "", "utf8");
  const checkerTimeout = await runLocalAutoIt(
    {
      code: '; CHECK_HANG\nConsoleWrite("must not run")',
      timeoutMs: 100,
    },
    root,
    autoitContext,
  );
  assert.equal(checkerTimeout.isError, true);
  assert.equal(checkerTimeout.structuredContent?.["phase"], "syntax_check");
  assert.equal(checkerTimeout.structuredContent?.["timedOut"], true);
  assert.equal(readFileSync(autoitLog, "utf8").trim(), "checked");
  assert.equal(autoItRequiresAdmin("#RequireAdmin\nConsoleWrite('Ada')"), true);
  assert.equal(
    autoItRequiresAdmin("  #requireadmin ; guarded global input\nExit 0"),
    true,
  );
  assert.equal(autoItRequiresAdmin("; #RequireAdmin\nExit 0"), false);
  assert.equal(autoItRequiresAdmin('ConsoleWrite("#RequireAdmin")'), false);

  const artifacts = readFileSync(String(artifact), "utf8");
  assert.match(artifacts, /Grace Hopper/);
  console.log("local script runtime verification passed");
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 50,
  });
}

function text(outcome: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return outcome.content.map((block) => block.text ?? "").join("\n");
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
