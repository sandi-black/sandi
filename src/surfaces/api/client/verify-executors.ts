import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertEqual, withTempDir } from "@/lib/verification/harness";
import {
  type ExecutorContext,
  executeLocalTool,
} from "@/surfaces/api/client/executors";
import { verifyBoundedRegex } from "@/surfaces/api/client/verify-bounded-regex";
import { verifyDesktopFileTransfer } from "@/surfaces/api/client/verify-desktop-file-transfer";
import {
  LocalBashParamsSchema,
  MAX_LOCAL_BASH_TIMEOUT_MS,
  type ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";

function text(outcome: ToolCallOutcome): string {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// executeLocalTool takes a validated BrokerCall (the wire boundary parses tool
// and params together), so these cases build typed calls directly. Malformed
// params are a boundary concern, covered by verify-desktop-client, not here.

async function verifyExecutors(): Promise<void> {
  verifyBoundedRegex();
  verifyBashTimeoutBoundary();
  await withTempDir("sandi-executors-", async (dir) => {
    const context: ExecutorContext = { rootDir: dir };
    await verifyWriteAndRead(context);
    await verifyEdit(context);
    await verifyEditRejectsInvalidUtf8(context);
    await verifyConcurrentEdits(context);
    await verifyList(context);
    await verifyGlob(context);
    await verifyTraversalBounds(context);
    await verifyGrep(context);
    await verifyDesktopFileTransfer(dir);
    await verifyBash(context);
    await verifyBashOutputBounds(context);
    await verifyBashCancellation(context);
    await verifyWindowsTaskkillFallback(context);
    await verifyBashTimeout(context);
    await verifyBashSettlementBackstop(context);
    await verifyStateToolRouting(context);
  });
  console.log("executors verification passed");
}

function verifyBashTimeoutBoundary(): void {
  assert(
    LocalBashParamsSchema.safeParse({
      command: "echo bounded",
      timeoutMs: MAX_LOCAL_BASH_TIMEOUT_MS,
    }).success,
    "the ten-minute shell timeout is accepted at the wire boundary",
  );
  assert(
    !LocalBashParamsSchema.safeParse({
      command: "echo never-spawned",
      timeoutMs: MAX_LOCAL_BASH_TIMEOUT_MS + 1,
    }).success,
    "a shell timeout over ten minutes is rejected before execution",
  );
  console.log("ok local_bash enforces the ten-minute timeout boundary");
}

async function verifyEditRejectsInvalidUtf8(
  context: ExecutorContext,
): Promise<void> {
  const path = join(context.rootDir, "binary.dat");
  const bytes = Buffer.from([0x61, 0xff, 0x62]);
  await writeFile(path, bytes);
  const outcome = await executeLocalTool(
    {
      tool: "local_edit",
      params: { path, oldString: "a", newString: "A" },
    },
    context,
  );
  assert(!outcome.ok, "edit refuses a file that is not valid UTF-8");
  assert(
    (await readFile(path)).equals(bytes),
    "refused binary edit leaves every byte unchanged",
  );
  console.log("ok local_edit refuses invalid UTF-8 without corrupting bytes");
}

async function verifyWriteAndRead(context: ExecutorContext): Promise<void> {
  const wrote = await executeLocalTool(
    {
      tool: "local_write",
      params: { path: "notes.txt", content: "alpha\nbeta\ngamma\n" },
    },
    context,
  );
  assert(wrote.ok, "write succeeds");
  const onDisk = await readFile(join(context.rootDir, "notes.txt"), "utf8");
  assertEqual(
    onDisk,
    "alpha\nbeta\ngamma\n",
    "write persists content verbatim",
  );

  const read = await executeLocalTool(
    { tool: "local_read", params: { path: "notes.txt" } },
    context,
  );
  assert(read.ok, "read succeeds");
  assert(text(read).includes("1\talpha"), "read numbers the first line");
  assert(text(read).includes("3\tgamma"), "read numbers the last line");

  const sliced = await executeLocalTool(
    { tool: "local_read", params: { path: "notes.txt", offset: 1, limit: 1 } },
    context,
  );
  assertEqual(text(sliced), "2\tbeta", "read honors offset and limit");
  console.log("ok local_write and local_read round-trip with line numbers");
}

async function verifyEdit(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    {
      tool: "local_write",
      params: { path: "edit.txt", content: "one two two three" },
    },
    context,
  );
  const notUnique = await executeLocalTool(
    {
      tool: "local_edit",
      params: { path: "edit.txt", oldString: "two", newString: "X" },
    },
    context,
  );
  assert(
    !notUnique.ok,
    "edit refuses a non-unique oldString without replaceAll",
  );

  const all = await executeLocalTool(
    {
      tool: "local_edit",
      params: {
        path: "edit.txt",
        oldString: "two",
        newString: "X",
        replaceAll: true,
      },
    },
    context,
  );
  assert(all.ok, "edit replaceAll succeeds");
  assertEqual(
    await readFile(join(context.rootDir, "edit.txt"), "utf8"),
    "one X X three",
    "edit replaceAll replaces every occurrence",
  );

  const missing = await executeLocalTool(
    {
      tool: "local_edit",
      params: { path: "edit.txt", oldString: "absent", newString: "Y" },
    },
    context,
  );
  assert(!missing.ok, "edit refuses an oldString that is not present");
  console.log("ok local_edit enforces uniqueness and presence");
}

async function verifyConcurrentEdits(context: ExecutorContext): Promise<void> {
  const path = join(context.rootDir, "concurrent-edit.txt");
  await writeFile(path, "alpha beta", "utf8");
  const outcomes = await Promise.all([
    executeLocalTool(
      {
        tool: "local_edit",
        params: { path, oldString: "alpha", newString: "ALPHA" },
      },
      context,
    ),
    executeLocalTool(
      {
        tool: "local_edit",
        params: { path, oldString: "beta", newString: "BETA" },
      },
      context,
    ),
  ]);
  assert(
    outcomes.every((outcome) => outcome.ok),
    "concurrent edits to one real path both succeed",
  );
  assertEqual(
    await readFile(path, "utf8"),
    "ALPHA BETA",
    "concurrent edits serialize instead of overwriting one another",
  );
  console.log("ok local_edit serializes same-file mutations");
}

async function verifyList(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    { tool: "local_write", params: { path: "dir/a.txt", content: "a" } },
    context,
  );
  await executeLocalTool(
    { tool: "local_write", params: { path: "dir/b.txt", content: "b" } },
    context,
  );
  const listed = await executeLocalTool(
    { tool: "local_ls", params: { path: "dir" } },
    context,
  );
  assert(listed.ok, "ls succeeds");
  assert(text(listed).includes("a.txt"), "ls shows a.txt");
  assert(text(listed).includes("b.txt"), "ls shows b.txt");
  console.log("ok local_ls lists a directory");
}

async function verifyGlob(context: ExecutorContext): Promise<void> {
  const fixtures: Array<[string, string]> = [
    ["src/x.ts", "x"],
    ["src/nested/y.ts", "y"],
    ["src/z.md", "z"],
  ];
  for (const [path, content] of fixtures) {
    await executeLocalTool(
      { tool: "local_write", params: { path, content } },
      context,
    );
  }
  const matched = await executeLocalTool(
    { tool: "local_glob", params: { pattern: "src/**/*.ts" } },
    context,
  );
  assert(matched.ok, "glob succeeds");
  assert(text(matched).includes("src/x.ts"), "glob matches a top-level file");
  assert(
    text(matched).includes("src/nested/y.ts"),
    "glob ** matches across directories",
  );
  assert(
    !text(matched).includes("src/z.md"),
    "glob excludes non-matching extensions",
  );

  // A missing base directory is a failed call, not an empty match set.
  const missing = await executeLocalTool(
    { tool: "local_glob", params: { pattern: "*", path: "no-such-dir" } },
    context,
  );
  assert(!missing.ok, "glob refuses a missing base directory");
  console.log("ok local_glob matches ** and refuses a missing base");
}

async function verifyTraversalBounds(context: ExecutorContext): Promise<void> {
  const emptyTree = join(context.rootDir, "empty-tree", "only", "directories");
  await mkdir(emptyTree, { recursive: true });
  const controller = new AbortController();
  const pending = executeLocalTool(
    {
      tool: "local_glob",
      params: { path: join(context.rootDir, "empty-tree"), pattern: "**/*" },
    },
    context,
    controller.signal,
  );
  controller.abort();
  const cancelled = await pending;
  assert(
    !cancelled.ok && cancelled.error === "cancelled",
    "a directory-only traversal notices cancellation before yielding a file",
  );

  const cappedDir = join(context.rootDir, "capped-glob");
  await mkdir(cappedDir, { recursive: true });
  await Promise.all(
    Array.from({ length: 1_001 }, (_, index) =>
      writeFile(
        join(cappedDir, `file-${String(index).padStart(4, "0")}.txt`),
        "x",
        "utf8",
      ),
    ),
  );
  const capped = await executeLocalTool(
    { tool: "local_glob", params: { path: cappedDir, pattern: "*.txt" } },
    context,
  );
  assert(capped.ok, "a capped glob still returns its bounded results");
  assert(
    text(capped).includes("search stopped after 1000 results"),
    "a capped glob states that its result is incomplete",
  );
  const listed = await executeLocalTool(
    { tool: "local_ls", params: { path: cappedDir } },
    context,
  );
  assert(
    listed.ok && text(listed).includes("listing truncated"),
    "a large directory listing is bounded before full materialization",
  );
  console.log("ok local traversal honors abort and reports result truncation");
}

async function verifyGrep(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    {
      tool: "local_write",
      params: { path: "grep/a.txt", content: "needle here\nhay\nNeEdLe again" },
    },
    context,
  );
  await executeLocalTool(
    { tool: "local_write", params: { path: "grep/b.md", content: "needle" } },
    context,
  );
  // A binary file (contains a NUL byte) must be skipped by the line search.
  await writeFile(
    join(context.rootDir, "grep", "bin.dat"),
    Buffer.concat([Buffer.from("needle here", "utf8"), Buffer.from([0])]),
  );
  const oversizedPath = join(context.rootDir, "grep", "oversized.txt");
  await writeFile(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const oversizedRead = await executeLocalTool(
    { tool: "local_read", params: { path: oversizedPath } },
    context,
  );
  assert(!oversizedRead.ok, "local_read refuses an over-limit text file");

  const found = await executeLocalTool(
    { tool: "local_grep", params: { pattern: "needle", path: "grep" } },
    context,
  );
  assert(found.ok, "grep succeeds");
  assert(
    text(found).includes("a.txt:1:needle here"),
    "grep reports path:line:text",
  );
  assert(!text(found).includes("NeEdLe"), "grep is case-sensitive by default");
  assert(!text(found).includes("bin.dat"), "grep skips binary files");
  assert(
    text(found).includes("over-8388608-byte file skipped"),
    "grep reports an over-limit file instead of allocating it",
  );

  const insensitive = await executeLocalTool(
    {
      tool: "local_grep",
      params: { pattern: "needle", path: "grep", ignoreCase: true },
    },
    context,
  );
  assert(
    text(insensitive).includes("NeEdLe again"),
    "grep ignoreCase matches mixed case",
  );

  const filtered = await executeLocalTool(
    {
      tool: "local_grep",
      params: { pattern: "needle", path: "grep", glob: "*.md" },
    },
    context,
  );
  assert(
    text(filtered).includes("b.md"),
    "grep glob filter keeps matching files",
  );
  assert(
    !text(filtered).includes("a.txt"),
    "grep glob filter excludes other files",
  );

  const unsupported = await executeLocalTool(
    {
      tool: "local_grep",
      params: {
        pattern: "(Ada)\\1",
        path: "directory-that-does-not-exist",
      },
    },
    context,
  );
  assert(
    !unsupported.ok &&
      (unsupported.error ?? "").includes("backreferences") &&
      !(unsupported.error ?? "").includes("does not exist"),
    "grep rejects unsupported syntax before traversing the filesystem",
  );
  console.log(
    "ok local_grep matches, filters, skips binaries, and validates before traversal",
  );
}

async function verifyBash(context: ExecutorContext): Promise<void> {
  const echoed = await executeLocalTool(
    { tool: "local_bash", params: { command: "echo hands-local" } },
    context,
  );
  assert(echoed.ok, "bash returns a result");
  assert(text(echoed).includes("hands-local"), "bash captures stdout");

  const failed = await executeLocalTool(
    { tool: "local_bash", params: { command: "exit 3" } },
    context,
  );
  assert(
    failed.ok,
    "a non-zero exit is still a returned result, not a refusal",
  );
  assert(text(failed).includes("exit code: 3"), "bash reports the exit code");
  console.log("ok local_bash captures output and exit codes");
}

async function verifyBashOutputBounds(context: ExecutorContext): Promise<void> {
  const command =
    'node -e "const b=Buffer.from([240,159,152,128]);' +
    "process.stdout.write(b.subarray(0,2));" +
    "setTimeout(()=>{process.stdout.write(b.subarray(2));" +
    "process.stdout.write('x'.repeat(1000000));},50)\"";
  const outcome = await executeLocalTool(
    { tool: "local_bash", params: { command } },
    context,
  );
  assert(outcome.ok, "a noisy UTF-8 command completes");
  assert(
    text(outcome).includes(String.fromCodePoint(0x1f600)),
    "UTF-8 split across subprocess chunks is decoded intact",
  );
  assert(
    !text(outcome).includes(String.fromCodePoint(0xfffd)),
    "split UTF-8 does not introduce replacement characters",
  );
  assert(
    text(outcome).includes("[truncated to 100000 characters]"),
    "subprocess output reports its memory-bound truncation",
  );
  assert(
    text(outcome).length < 100_100,
    "subprocess output retained in the result stays bounded",
  );
  console.log("ok local_bash bounds output and decodes split UTF-8");
}

async function verifyBashCancellation(context: ExecutorContext): Promise<void> {
  // A pre-aborted signal short-circuits before spawning anything.
  const already = new AbortController();
  already.abort();
  const refusedEarly = await executeLocalTool(
    { tool: "local_bash", params: { command: "echo should-not-run" } },
    context,
    already.signal,
  );
  assert(
    !refusedEarly.ok && refusedEarly.error === "cancelled",
    "an already-aborted signal refuses before running the command",
  );

  // Aborting mid-flight kills the child and refuses rather than waiting it out.
  // The command sleeps far longer than the cancel delay, so resolving promptly
  // is the proof the whole process tree was actually killed: signaling only the
  // shell wrapper would leave the command holding the output pipe and the call
  // would not settle until the sleep elapsed.
  const controller = new AbortController();
  const sleepSeconds = 30;
  const sleepCmd =
    process.platform === "win32"
      ? `ping -n ${sleepSeconds} 127.0.0.1 > NUL`
      : `sleep ${sleepSeconds}`;
  const startedAt = Date.now();
  const pending = executeLocalTool(
    { tool: "local_bash", params: { command: sleepCmd } },
    context,
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 100);
  const outcome = await pending;
  clearTimeout(timer);
  const elapsedMs = Date.now() - startedAt;
  assert(
    !outcome.ok && outcome.error === "cancelled",
    "aborting a running command kills it and refuses",
  );
  assert(
    elapsedMs < (sleepSeconds * 1000) / 2,
    `a cancelled command must stop promptly, not run to completion (took ${elapsedMs}ms)`,
  );
  console.log("ok local_bash honors cancellation");
}

async function verifyWindowsTaskkillFallback(
  context: ExecutorContext,
): Promise<void> {
  if (process.platform !== "win32") return;

  await withFailingTaskkill(context, "fallback", 250, async (logPath) => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executeLocalTool(
      {
        tool: "local_bash",
        params: {
          command: "for /L %i in (1,1,2147483647) do @rem",
          timeoutMs: 50,
        },
      },
      context,
      controller.signal,
    );
    const abortTimer = setTimeout(() => controller.abort(), 75);
    const outcome = await pending;
    clearTimeout(abortTimer);
    const elapsedMs = Date.now() - startedAt;
    const invocations = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);

    assert(
      !outcome.ok && outcome.error === "cancelled",
      "abort wins when it races a shell timeout",
    );
    assertEqual(
      invocations.length,
      1,
      "timeout and abort share one Windows termination sequence",
    );
    assert(
      elapsedMs < 2_000,
      `a non-zero taskkill exit falls back to the process handle (took ${elapsedMs}ms)`,
    );
  });
  console.log(
    "ok local_bash handles taskkill failure with one termination sequence",
  );
}

async function verifyBashTimeout(context: ExecutorContext): Promise<void> {
  // A command that outruns its timeout never completed, so it is a failed call
  // (ok: false), not a result. It must also resolve near the timeout, proving
  // the process tree was killed rather than waited out.
  const sleepCmd =
    process.platform === "win32" ? "ping -n 30 127.0.0.1 > NUL" : "sleep 30";
  const startedAt = Date.now();
  const outcome = await executeLocalTool(
    { tool: "local_bash", params: { command: sleepCmd, timeoutMs: 200 } },
    context,
  );
  const elapsedMs = Date.now() - startedAt;
  assert(
    !outcome.ok &&
      outcome.error !== undefined &&
      outcome.error.includes("timed out"),
    "a timed-out command is a failed call, not a successful result",
  );
  assert(
    elapsedMs < 10_000,
    `a timed-out command must be killed promptly (took ${elapsedMs}ms)`,
  );
  console.log("ok local_bash reports a timeout as a failed call");
}

async function verifyBashSettlementBackstop(
  context: ExecutorContext,
): Promise<void> {
  const fixturePath = join(context.rootDir, "escaped-stdio-child.cjs");
  const pidPath = join(context.rootDir, "escaped-stdio-child.pids");
  await writeFile(
    fixturePath,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const child = spawn(process.execPath,",
      '  ["-e", "setInterval(() => {}, 1000)"],',
      "  {",
      "    detached: true,",
      '    stdio: ["ignore", "inherit", "inherit"],',
      "    windowsHide: true,",
      "  },",
      ");",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + "\\n" + String(child.pid) + "\\n", "utf8");`,
      "child.unref();",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  const command = `"${process.execPath}" "${fixturePath}"`;
  let fixturePids: number[] = [];
  try {
    const run = async (): Promise<{
      elapsedMs: number;
      outcome: Awaited<ReturnType<typeof executeLocalTool>>;
    }> => {
      const startedAt = Date.now();
      const outcome = await executeLocalTool(
        {
          tool: "local_bash",
          params: { command, timeoutMs: 1_000 },
        },
        context,
      );
      return { elapsedMs: Date.now() - startedAt, outcome };
    };
    const result =
      process.platform === "win32"
        ? await withFailingTaskkill(context, "backstop", 0, run)
        : await run();
    fixturePids = parseFixturePids(await readFile(pidPath, "utf8"));
    const escapedPid = fixturePids.at(-1);

    assert(
      !result.outcome.ok &&
        result.outcome.error !== undefined &&
        result.outcome.error.includes("timed out"),
      "a timed-out command settles even when an escaped child keeps stdio open",
    );
    assert(
      result.elapsedMs >= 3_000 && result.elapsedMs < 8_000,
      `the no-close backstop settles after kill escalation (took ${result.elapsedMs}ms)`,
    );
    assert(
      escapedPid !== undefined && isProcessRunning(escapedPid),
      "the escaped pipe owner is still alive when the backstop settles",
    );
  } finally {
    for (const pid of fixturePids.reverse()) terminateFixtureProcess(pid);
  }
  console.log("ok local_bash has a bounded no-close settlement backstop");
}

async function withFailingTaskkill<T>(
  context: ExecutorContext,
  name: string,
  delayMs: number,
  run: (logPath: string) => Promise<T>,
): Promise<T> {
  const shimDir = join(context.rootDir, `taskkill-${name}`);
  const shimPath = join(shimDir, "taskkill.exe");
  const preloadPath = join(shimDir, "preload.cjs");
  const logPath = join(shimDir, "invocations.log");
  await mkdir(shimDir, { recursive: true });
  await copyFile(process.execPath, shimPath);
  await writeFile(
    preloadPath,
    [
      'const { appendFileSync } = require("node:fs");',
      'const { basename } = require("node:path");',
      'if (basename(process.execPath).toLowerCase() === "taskkill.exe") {',
      '  appendFileSync(process.env.SANDI_TASKKILL_LOG, "taskkill\\n", "utf8");',
      '  const delay = Number(process.env.SANDI_TASKKILL_DELAY_MS ?? "0");',
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
      "  process.exit(9);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousPath = process.env["PATH"];
  const previousNodeOptions = process.env["NODE_OPTIONS"];
  const previousLog = process.env["SANDI_TASKKILL_LOG"];
  const previousDelay = process.env["SANDI_TASKKILL_DELAY_MS"];
  const previousCwd = process.cwd();
  process.env["PATH"] = `${shimDir};${previousPath ?? ""}`;
  process.env["NODE_OPTIONS"] = [
    previousNodeOptions,
    `--require=${preloadPath}`,
  ]
    .filter((value) => value !== undefined && value.length > 0)
    .join(" ");
  process.env["SANDI_TASKKILL_LOG"] = logPath;
  process.env["SANDI_TASKKILL_DELAY_MS"] = String(delayMs);
  process.chdir(shimDir);
  try {
    return await run(logPath);
  } finally {
    process.chdir(previousCwd);
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("NODE_OPTIONS", previousNodeOptions);
    restoreEnvironment("SANDI_TASKKILL_LOG", previousLog);
    restoreEnvironment("SANDI_TASKKILL_DELAY_MS", previousDelay);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function parseFixturePids(value: string): number[] {
  return value
    .trim()
    .split("\n")
    .map((pid) => Number(pid))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function terminateFixtureProcess(pid: number): void {
  if (pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function verifyStateToolRouting(context: ExecutorContext): Promise<void> {
  // local_list_desktops is answered by the broker; if one ever reaches a desktop
  // the executor refuses it rather than acting, so the switch stays exhaustive.
  const desktops = await executeLocalTool(
    { tool: "local_list_desktops", params: {} },
    context,
  );
  assert(
    !desktops.ok,
    "local_list_desktops is refused on the desktop (the broker answers it)",
  );

  // The state tools route to the Windows capture path: a real result on Windows,
  // a platform refusal elsewhere. Either way the tool name reached its executor.
  const monitors = await executeLocalTool(
    { tool: "local_list_monitors", params: {} },
    context,
  );
  if (process.platform === "win32") {
    assert(monitors.ok, "local_list_monitors runs on a Windows desktop");
  } else {
    assert(
      !monitors.ok && (monitors.error ?? "").includes("only supported"),
      "local_list_monitors refuses on a non-Windows desktop",
    );
  }

  const activity = await executeLocalTool(
    { tool: "local_desktop_activity", params: {} },
    context,
  );
  if (process.platform === "win32") {
    assert(activity.ok, "local_desktop_activity runs on a Windows desktop");
  } else {
    assert(
      !activity.ok && (activity.error ?? "").includes("only supported"),
      "local_desktop_activity refuses on a non-Windows desktop",
    );
  }
  console.log("ok the state tools route to their executors");
}

await verifyExecutors();
