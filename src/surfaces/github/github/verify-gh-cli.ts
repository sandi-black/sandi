import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissingPathError } from "@/lib/fs-errors";
import { assert, withTempDir } from "@/lib/verification/harness";
import { GhCli, GhCliError } from "@/surfaces/github/github/gh-cli";

await withTempDir("sandi-gh-cli-", async (workDir) => {
  const survivorScript = join(workDir, "survivor.mjs");
  await writeFile(
    survivorScript,
    `import { writeFileSync } from "node:fs";

const pidFile = process.env["SANDI_FAKE_GH_PID_FILE"];
if (!pidFile) throw new Error("missing survivor pid file");
writeFileSync(pidFile, String(process.pid), "utf8");
process.on("SIGTERM", () => undefined);
if (process.send) process.send("ready");
setTimeout(() => process.exit(99), 15_000).unref();
setInterval(() => undefined, 1_000);
`,
    "utf8",
  );

  const fakeScript = join(workDir, "fake-gh.mjs");
  await writeFile(
    fakeScript,
    String.raw`#!/usr/bin/env node
import { closeSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const endpoint = process.argv.at(-1);
const pidDir = process.env["SANDI_FAKE_GH_PID_DIR"];
if (pidDir && endpoint?.startsWith("/")) {
  writeFileSync(join(pidDir, endpoint.slice(1) + ".pid"), String(process.pid), "utf8");
}
setTimeout(() => process.exit(99), 15_000).unref();
if (endpoint === "/utf8") {
  const output = Buffer.from("Grace Hopper: caf\u00e9 \ud83d\ude80");
  const rocket = Buffer.from("\ud83d\ude80");
  const splitAt = output.indexOf(rocket) + 1;
  process.stdout.write(output.subarray(0, splitAt));
  setTimeout(() => process.stdout.end(output.subarray(splitAt)), 30);
} else if (endpoint === "/overflow-tree") {
  const survivorScript = process.env["SANDI_FAKE_GH_SURVIVOR"];
  if (!survivorScript) throw new Error("missing survivor script");
  const survivor = spawn(process.execPath, [survivorScript], {
    env: process.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  survivor.once("message", () => {
    process.stdout.write(Buffer.alloc(4_096, 65));
  });
  setInterval(() => undefined, 1_000);
} else if (endpoint === "/stderr-overflow") {
  process.stderr.write(Buffer.alloc(4_096, 66));
  setInterval(() => undefined, 1_000);
} else if (endpoint === "/abort") {
  setInterval(() => undefined, 1_000);
} else if (endpoint === "/stdin-error") {
  closeSync(0);
  process.exit(0);
} else if (endpoint === "/hang") {
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.end("{}");
}
`,
    "utf8",
  );

  const command = await fakeGhCommand(workDir, fakeScript);
  const pidFile = join(workDir, "survivor.pid");
  const env = {
    ...process.env,
    SANDI_FAKE_GH_PID_FILE: pidFile,
    SANDI_FAKE_GH_PID_DIR: workDir,
    SANDI_FAKE_GH_SURVIVOR: survivorScript,
  };

  const gh = new GhCli({ command, env, timeoutMs: 3_000 });
  const utf8 = await gh.apiText({ endpoint: "/utf8" });
  assert(
    utf8 === "Grace Hopper: caf\u00e9 \ud83d\ude80",
    `split UTF-8 should round-trip without replacement characters: ${utf8}`,
  );

  const bounded = new GhCli({
    command,
    env,
    timeoutMs: 3_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
  });
  const overflow = await expectGhFailure(
    bounded.apiText({ endpoint: "/overflow-tree" }),
  );
  assert(
    overflow.stderr.includes("stdout exceeded 1024 byte limit"),
    `stdout overflow should report its byte limit: ${overflow.stderr}`,
  );
  const survivorPid = Number(await readFile(pidFile, "utf8"));
  assert(Number.isSafeInteger(survivorPid), "survivor should publish its pid");
  await waitForProcessExit(
    Number(await readFile(join(workDir, "overflow-tree.pid"), "utf8")),
    7_000,
  );
  await waitForProcessExit(survivorPid, 7_000);

  const stderrOverflow = await expectGhFailure(
    bounded.apiText({ endpoint: "/stderr-overflow" }),
  );
  assert(
    stderrOverflow.stderr.includes("stderr exceeded 1024 byte limit"),
    `stderr overflow should report its byte limit: ${stderrOverflow.stderr}`,
  );
  await waitForProcessExit(
    Number(await readFile(join(workDir, "stderr-overflow.pid"), "utf8")),
    7_000,
  );

  const controller = new AbortController();
  const abortedRun = gh.apiText({
    endpoint: "/abort",
    signal: controller.signal,
  });
  const abortPid = Number(await waitForFile(join(workDir, "abort.pid"), 3_000));
  controller.abort(new Error("Ada stopped the request"));
  const aborted = await expectGhFailure(abortedRun);
  assert(
    aborted.stderr === "aborted: Ada stopped the request",
    `abort should preserve its reason: ${aborted.stderr}`,
  );
  await waitForProcessExit(abortPid, 7_000);

  const timeoutGh = new GhCli({ command, env, timeoutMs: 500 });
  const timeoutStartedAt = Date.now();
  const timedOut = await expectGhFailure(
    timeoutGh.apiText({ endpoint: "/hang" }),
  );
  assert(
    timedOut.stderr.includes("timed out after 500ms"),
    `timeout should identify its deadline: ${timedOut.stderr}`,
  );
  assert(
    Date.now() - timeoutStartedAt < 2_000,
    "gh timeout should settle promptly",
  );
  const hangPid = Number(await waitForFile(join(workDir, "hang.pid"), 1_000));
  await waitForProcessExit(hangPid, 7_000);

  const stdinFailure = await expectGhFailure(
    gh.apiText({
      endpoint: "/stdin-error",
      method: "POST",
      body: { body: "a".repeat(2 * 1024 * 1024) },
    }),
  );
  assert(
    stdinFailure.stderr.startsWith("stdin failed:"),
    `stdin failure should be observed: ${stdinFailure.stderr}`,
  );

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const preAborted = await expectGhFailure(
    gh.apiText({ endpoint: "/utf8", signal: alreadyAborted.signal }),
  );
  assert(preAborted.stderr === "aborted", "pre-aborted calls should not spawn");

  console.log("GitHub gh cli verification passed");
});

async function fakeGhCommand(
  workDir: string,
  fakeScript: string,
): Promise<string> {
  if (process.platform !== "win32") {
    await chmod(fakeScript, 0o700);
    return fakeScript;
  }
  const command = join(workDir, "fake-gh.cmd");
  const nodePath = process.execPath.replaceAll("%", "%%");
  const scriptPath = fakeScript.replaceAll("%", "%%");
  await writeFile(
    command,
    `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`,
    "utf8",
  );
  return command;
}

async function expectGhFailure(promise: Promise<unknown>): Promise<GhCliError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(
    caught instanceof GhCliError,
    "gh command should fail with GhCliError",
  );
  return caught;
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  let value: string | undefined;
  await waitUntil(async () => {
    try {
      value = await readFile(path, "utf8");
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }, timeoutMs);
  assert(value !== undefined, `timed out waiting for ${path}`);
  return value;
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  await waitUntil(() => !isProcessAlive(pid), timeoutMs);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    assert(
      Date.now() < deadline,
      `condition did not settle within ${timeoutMs}ms`,
    );
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
