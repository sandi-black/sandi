import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoItInputFenceError,
  autoItRequiresAdmin,
  type LocalScriptRuntimeContext,
  runLocalAutoIt,
  runLocalJavaScript,
} from "@/surfaces/api/client/local-script-runtimes";

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
  assert.match(
    autoItInputFenceError('Send("unsafe")') ?? "",
    /requires exit cleanup/,
  );
  assert.match(
    autoItInputFenceError(
      [
        'OnAutoItExitRegister("ReleaseInput")',
        "If Not BlockInput(1) Then Exit 2",
        'Send("guarded")',
        "BlockInput(0)",
        'Send("unsafe after release")',
      ].join("\n"),
    ) ?? "",
    /requires exit cleanup/,
  );
  assert.equal(
    autoItInputFenceError(
      [
        'OnAutoItExitRegister("ReleaseInput")',
        "If Not BlockInput(1) Then Exit 2",
        'Send("guarded")',
        "BlockInput(0)",
        "Func ReleaseInput()",
        "    BlockInput(0)",
        "EndFunc",
      ].join("\n"),
    ),
    undefined,
  );
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
