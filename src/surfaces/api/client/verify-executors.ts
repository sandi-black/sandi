import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExecutorContext,
  executeLocalTool,
} from "@/surfaces/api/client/executors";

async function verifyExecutors(): Promise<void> {
  await withTempDir(async (dir) => {
    const context: ExecutorContext = { rootDir: dir };
    await verifyWriteAndRead(context);
    await verifyEdit(context);
    await verifyList(context);
    await verifyGlob(context);
    await verifyGrep(context);
    await verifyBash(context);
    await verifyBashCancellation(context);
    await verifyBashTimeout(context);
    await verifyBadParams(context);
  });
  console.log("executors verification passed");
}

async function verifyWriteAndRead(context: ExecutorContext): Promise<void> {
  const wrote = await executeLocalTool(
    "local_write",
    { path: "notes.txt", content: "alpha\nbeta\ngamma\n" },
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
    "local_read",
    { path: "notes.txt" },
    context,
  );
  assert(read.ok, "read succeeds");
  assert(read.output.includes("1\talpha"), "read numbers the first line");
  assert(read.output.includes("3\tgamma"), "read numbers the last line");

  const sliced = await executeLocalTool(
    "local_read",
    { path: "notes.txt", offset: 1, limit: 1 },
    context,
  );
  assertEqual(sliced.output, "2\tbeta", "read honors offset and limit");
  console.log("ok local_write and local_read round-trip with line numbers");
}

async function verifyEdit(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    "local_write",
    { path: "edit.txt", content: "one two two three" },
    context,
  );
  const notUnique = await executeLocalTool(
    "local_edit",
    { path: "edit.txt", oldString: "two", newString: "X" },
    context,
  );
  assert(
    !notUnique.ok,
    "edit refuses a non-unique oldString without replaceAll",
  );

  const all = await executeLocalTool(
    "local_edit",
    { path: "edit.txt", oldString: "two", newString: "X", replaceAll: true },
    context,
  );
  assert(all.ok, "edit replaceAll succeeds");
  assertEqual(
    await readFile(join(context.rootDir, "edit.txt"), "utf8"),
    "one X X three",
    "edit replaceAll replaces every occurrence",
  );

  const missing = await executeLocalTool(
    "local_edit",
    { path: "edit.txt", oldString: "absent", newString: "Y" },
    context,
  );
  assert(!missing.ok, "edit refuses an oldString that is not present");
  console.log("ok local_edit enforces uniqueness and presence");
}

async function verifyList(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    "local_write",
    { path: "dir/a.txt", content: "a" },
    context,
  );
  await executeLocalTool(
    "local_write",
    { path: "dir/b.txt", content: "b" },
    context,
  );
  const listed = await executeLocalTool("local_ls", { path: "dir" }, context);
  assert(listed.ok, "ls succeeds");
  assert(listed.output.includes("a.txt"), "ls shows a.txt");
  assert(listed.output.includes("b.txt"), "ls shows b.txt");
  console.log("ok local_ls lists a directory");
}

async function verifyGlob(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    "local_write",
    { path: "src/x.ts", content: "x" },
    context,
  );
  await executeLocalTool(
    "local_write",
    { path: "src/nested/y.ts", content: "y" },
    context,
  );
  await executeLocalTool(
    "local_write",
    { path: "src/z.md", content: "z" },
    context,
  );
  const matched = await executeLocalTool(
    "local_glob",
    { pattern: "src/**/*.ts" },
    context,
  );
  assert(matched.ok, "glob succeeds");
  assert(matched.output.includes("src/x.ts"), "glob matches a top-level file");
  assert(
    matched.output.includes("src/nested/y.ts"),
    "glob ** matches across directories",
  );
  assert(
    !matched.output.includes("src/z.md"),
    "glob excludes non-matching extensions",
  );
  console.log("ok local_glob matches ** across directories");
}

async function verifyGrep(context: ExecutorContext): Promise<void> {
  await executeLocalTool(
    "local_write",
    { path: "grep/a.txt", content: "needle here\nhay\nNeEdLe again" },
    context,
  );
  await executeLocalTool(
    "local_write",
    { path: "grep/b.md", content: "needle" },
    context,
  );
  // A binary file (contains a NUL byte) must be skipped by the line search.
  await writeFile(
    join(context.rootDir, "grep", "bin.dat"),
    Buffer.concat([Buffer.from("needle here", "utf8"), Buffer.from([0])]),
  );

  const found = await executeLocalTool(
    "local_grep",
    { pattern: "needle", path: "grep" },
    context,
  );
  assert(found.ok, "grep succeeds");
  assert(
    found.output.includes("a.txt:1:needle here"),
    "grep reports path:line:text",
  );
  assert(!found.output.includes("NeEdLe"), "grep is case-sensitive by default");
  assert(!found.output.includes("bin.dat"), "grep skips binary files");

  const insensitive = await executeLocalTool(
    "local_grep",
    { pattern: "needle", path: "grep", ignoreCase: true },
    context,
  );
  assert(
    insensitive.output.includes("NeEdLe again"),
    "grep ignoreCase matches mixed case",
  );

  const filtered = await executeLocalTool(
    "local_grep",
    { pattern: "needle", path: "grep", glob: "*.md" },
    context,
  );
  assert(
    filtered.output.includes("b.md"),
    "grep glob filter keeps matching files",
  );
  assert(
    !filtered.output.includes("a.txt"),
    "grep glob filter excludes other files",
  );
  console.log("ok local_grep matches, filters, and skips binaries");
}

async function verifyBash(context: ExecutorContext): Promise<void> {
  const echoed = await executeLocalTool(
    "local_bash",
    { command: "echo hands-local" },
    context,
  );
  assert(echoed.ok, "bash returns a result");
  assert(echoed.output.includes("hands-local"), "bash captures stdout");

  const failed = await executeLocalTool(
    "local_bash",
    { command: "exit 3" },
    context,
  );
  assert(
    failed.ok,
    "a non-zero exit is still a returned result, not a refusal",
  );
  assert(failed.output.includes("exit code: 3"), "bash reports the exit code");
  console.log("ok local_bash captures output and exit codes");
}

async function verifyBashCancellation(context: ExecutorContext): Promise<void> {
  // A pre-aborted signal short-circuits before spawning anything.
  const already = new AbortController();
  already.abort();
  const refusedEarly = await executeLocalTool(
    "local_bash",
    { command: "echo should-not-run" },
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
    "local_bash",
    { command: sleepCmd },
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

async function verifyBashTimeout(context: ExecutorContext): Promise<void> {
  // A command that outruns its timeout never completed, so it is a failed call
  // (ok: false), not a result. It must also resolve near the timeout, proving
  // the process tree was killed rather than waited out.
  const sleepCmd =
    process.platform === "win32" ? "ping -n 30 127.0.0.1 > NUL" : "sleep 30";
  const startedAt = Date.now();
  const outcome = await executeLocalTool(
    "local_bash",
    { command: sleepCmd, timeoutMs: 200 },
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

async function verifyBadParams(context: ExecutorContext): Promise<void> {
  const bad = await executeLocalTool("local_read", { path: 42 }, context);
  assert(!bad.ok, "a malformed param is refused");
  assert(bad.error !== undefined, "a refusal carries an error message");
  console.log("ok malformed params are refused");
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sandi-executors-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (condition) return;
  console.error(`assertion failed: ${message}`);
  process.exit(1);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

await verifyExecutors();
