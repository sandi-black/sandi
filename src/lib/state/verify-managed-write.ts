import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withManagedWrite } from "@/lib/state/managed-write";
import { assert, withTempDir } from "@/lib/verification/harness";

const CHILD_MODE_ENV = "SANDI_MANAGED_WRITE_CHILD";
const CHILD_KIND_ENV = "SANDI_MANAGED_WRITE_KIND";
const CHILD_TARGET_ENV = "SANDI_MANAGED_WRITE_TARGET";
const CHILD_TAG_ENV = "SANDI_MANAGED_WRITE_TAG";
const CHILD_COUNT_ENV = "SANDI_MANAGED_WRITE_APPENDS";
const CHILD_HOLD_MS_ENV = "SANDI_MANAGED_WRITE_HOLD_MS";
const CHILD_READY_ENV = "SANDI_MANAGED_WRITE_READY";

const CHILD_PROCESSES = 6;
const APPENDS_PER_CHILD = 30;
const STEAL_RACERS = 5;
// Must exceed managed-write's STALE_MS (30s) plus heartbeat jitter so the held
// section outlives the staleness window and proves the heartbeat keeps it
// alive. Kept just over the threshold to bound test runtime.
const LONG_HOLD_MS = 33_000;

if (process.env[CHILD_MODE_ENV] === "1") {
  await runChild();
} else {
  await runMain();
}

async function runChild(): Promise<void> {
  const kind = process.env[CHILD_KIND_ENV] ?? "append";
  if (kind === "append") return runAppendChild();
  if (kind === "hold") return runHoldChild();
  if (kind === "steal") return runStealChild();
  console.error(`FAIL: unknown child kind ${kind}`);
  process.exit(1);
}

async function runAppendChild(): Promise<void> {
  const target = requireEnv(CHILD_TARGET_ENV);
  const tag = requireEnv(CHILD_TAG_ENV);
  const appends = Number.parseInt(requireEnv(CHILD_COUNT_ENV), 10);
  for (let index = 0; index < appends; index += 1) {
    await withManagedWrite(target, async () => {
      const existing = await readExisting(target);
      await writeFile(target, `${existing}${tag}:${index}\n`, "utf8");
    });
  }
}

// Acquires the lock and holds it through a long critical section, signalling
// readiness by creating a marker file. The heartbeat must keep the lock alive
// for the entire hold even though it exceeds STALE_MS, and the final write must
// survive.
async function runHoldChild(): Promise<void> {
  const target = requireEnv(CHILD_TARGET_ENV);
  const tag = requireEnv(CHILD_TAG_ENV);
  const holdMs = Number.parseInt(requireEnv(CHILD_HOLD_MS_ENV), 10);
  const readyPath = requireEnv(CHILD_READY_ENV);
  await withManagedWrite(target, async () => {
    await writeFile(readyPath, "ready", "utf8");
    await delay(holdMs);
    await writeFile(target, `${tag}\n`, "utf8");
  });
}

// Steals a stale lock and appends its tag once. Used to race many stealers at
// the same pre-seeded stale lock.
async function runStealChild(): Promise<void> {
  const target = requireEnv(CHILD_TARGET_ENV);
  const tag = requireEnv(CHILD_TAG_ENV);
  await withManagedWrite(target, async () => {
    const existing = await readExisting(target);
    await writeFile(target, `${existing}${tag}\n`, "utf8");
  });
}

async function runMain(): Promise<void> {
  await withTempDir("sandi-managed-write-", async (tempRoot) => {
    await runConcurrencyTest(tempRoot);
    await runDeadPidStaleTest(tempRoot);
    await runMalformedLockTest(tempRoot);
    await runConcurrentStealersTest(tempRoot);
    await runOwnerTokenReleaseTest(tempRoot);
    await runLiveLongHoldTest(tempRoot);
    console.log("Managed-write verification passed");
  });
}

async function runConcurrencyTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "concurrency", "shared.log");
  await mkdir(join(tempRoot, "concurrency"), { recursive: true });
  await writeFile(target, "", "utf8");

  const children = Array.from({ length: CHILD_PROCESSES }, (_, index) =>
    spawnAppendChild(target, `child-${index}`, APPENDS_PER_CHILD),
  );
  const codes = await Promise.all(children);
  for (const [index, code] of codes.entries()) {
    assert(
      code === 0,
      `Child ${index} exited with code ${code}; expected a clean exit`,
    );
  }

  const lines = (await readFile(target, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const expectedTotal = CHILD_PROCESSES * APPENDS_PER_CHILD;
  assert(
    lines.length === expectedTotal,
    `Expected exactly ${expectedTotal} appended lines, found ${lines.length}; a lost or interleaved write occurred`,
  );

  const seen = new Set(lines);
  assert(
    seen.size === expectedTotal,
    `Expected ${expectedTotal} unique lines, found ${seen.size}; a duplicated or corrupted write occurred`,
  );
  for (let child = 0; child < CHILD_PROCESSES; child += 1) {
    for (let index = 0; index < APPENDS_PER_CHILD; index += 1) {
      const expected = `child-${child}:${index}`;
      assert(
        seen.has(expected),
        `Missing expected line "${expected}"; a write was lost`,
      );
    }
  }
  for (const line of lines) {
    assert(
      /^child-\d+:\d+$/.test(line),
      `Corrupted or interleaved line found: "${line}"`,
    );
  }

  console.log(
    `ok concurrency: ${CHILD_PROCESSES} processes x ${APPENDS_PER_CHILD} appends = ${expectedTotal} clean lines`,
  );
}

// A lock left behind by a dead pid with a long-stale heartbeat must be stolen
// promptly rather than blocking the acquire timeout.
async function runDeadPidStaleTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "stale", "value.txt");
  await mkdir(join(tempRoot, "stale"), { recursive: true });
  await writeFile(target, "before\n", "utf8");

  const lockPath = `${target}.lock`;
  const deadPid = await findDeadPid();
  await writeFile(lockPath, staleLockJson(deadPid), "utf8");

  const start = Date.now();
  await withManagedWrite(target, async () => {
    await writeFile(target, "after\n", "utf8");
  });
  const elapsed = Date.now() - start;

  const value = await readFile(target, "utf8");
  assert(
    value === "after\n",
    `Stale lock was not stolen: expected "after" but read ${JSON.stringify(value)}`,
  );
  assert(
    elapsed < 5_000,
    `Stealing a stale lock took ${elapsed}ms; expected well under the acquire timeout`,
  );

  console.log(
    `ok stale-lock: stole lock from dead pid ${deadPid} in ${elapsed}ms`,
  );
}

// A malformed (truncated) lockfile from a holder that crashed mid-create is not
// proof of staleness on its own. It must be recovered only once its mtime has
// aged past the grace window. We backdate the mtime to simulate that and assert
// the acquire succeeds promptly.
async function runMalformedLockTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "malformed", "value.txt");
  await mkdir(join(tempRoot, "malformed"), { recursive: true });
  await writeFile(target, "before\n", "utf8");

  const lockPath = `${target}.lock`;
  // Empty content is the worst case: a holder opened the lock but crashed before
  // writing any metadata.
  await writeFile(lockPath, "", "utf8");
  const aged = new Date(Date.now() - 5 * 60_000);
  await utimes(lockPath, aged, aged);

  const start = Date.now();
  await withManagedWrite(target, async () => {
    await writeFile(target, "after\n", "utf8");
  });
  const elapsed = Date.now() - start;

  const value = await readFile(target, "utf8");
  assert(
    value === "after\n",
    `Malformed lock was not recovered: expected "after" but read ${JSON.stringify(value)}`,
  );
  assert(
    elapsed < 5_000,
    `Recovering an aged malformed lock took ${elapsed}ms; expected well under the acquire timeout`,
  );

  console.log(
    `ok malformed-lock: recovered an aged empty lockfile in ${elapsed}ms`,
  );
}

// Many processes race to steal the same pre-seeded stale lock at once. The
// atomic rename-steal must let exactly one winner proceed at a time so every
// append survives with no loss, duplication, or corruption.
async function runConcurrentStealersTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "stealers", "value.txt");
  await mkdir(join(tempRoot, "stealers"), { recursive: true });
  await writeFile(target, "", "utf8");

  const lockPath = `${target}.lock`;
  const deadPid = await findDeadPid();
  await writeFile(lockPath, staleLockJson(deadPid), "utf8");

  const children = Array.from({ length: STEAL_RACERS }, (_, index) =>
    spawnChild("steal", { target, tag: `steal-${index}` }),
  );
  const codes = await Promise.all(children);
  for (const [index, code] of codes.entries()) {
    assert(
      code === 0,
      `Stealer ${index} exited with code ${code}; expected a clean exit`,
    );
  }

  const lines = (await readFile(target, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  assert(
    lines.length === STEAL_RACERS,
    `Expected ${STEAL_RACERS} stealer appends, found ${lines.length}; a steal race lost or duplicated a write`,
  );
  const seen = new Set(lines);
  assert(
    seen.size === STEAL_RACERS,
    `Expected ${STEAL_RACERS} unique stealer lines, found ${seen.size}; a steal race duplicated a write`,
  );

  console.log(
    `ok concurrent-stealers: ${STEAL_RACERS} processes raced one stale lock with no lost writes`,
  );
}

// After a stale lock is stolen and replaced by a new holder, the original
// (presumed dead) holder must never delete the new holder's lock. We simulate
// the new holder by writing a fresh lock with a different token, then assert
// that acquiring blocks until that fresh lock is itself released, proving the
// release path keys on the owner token rather than the path.
async function runOwnerTokenReleaseTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "owner-token", "value.txt");
  await mkdir(join(tempRoot, "owner-token"), { recursive: true });
  await writeFile(target, "before\n", "utf8");

  const lockPath = `${target}.lock`;
  // A live holder (our own live pid) with a fresh heartbeat: a different owner
  // than any caller, and definitely not stale.
  const freshLock = JSON.stringify({
    pid: process.pid,
    token: "fresh-owner-token",
    heartbeat: Date.now(),
  });
  await writeFile(lockPath, `${freshLock}\n`, "utf8");

  const start = Date.now();
  let acquired = false;
  const acquire = withManagedWrite(target, async () => {
    acquired = true;
    await writeFile(target, "after\n", "utf8");
  });

  // Keep refreshing the heartbeat for a short while so the lock stays live, then
  // release it and confirm the waiter only then proceeds.
  await delay(1_000);
  assert(
    !acquired,
    "Acquire entered the critical section while a live foreign-owned lock was held; release must key on the owner token",
  );
  await rm(lockPath, { force: true });
  await acquire;
  const elapsed = Date.now() - start;

  const value = await readFile(target, "utf8");
  assert(
    value === "after\n",
    `Owner-token test final value wrong: expected "after" but read ${JSON.stringify(value)}`,
  );
  assert(
    elapsed >= 1_000,
    `Acquire returned in ${elapsed}ms; it should have waited for the live foreign lock to be released`,
  );

  console.log(
    "ok owner-token: a foreign-owned live lock blocked acquire until released",
  );
}

// A process holds the lock through a critical section longer than STALE_MS. Its
// heartbeat must keep the lock alive so a second process cannot steal it as
// stale: the second process may proceed only after the holder releases, and the
// holder's write must survive.
async function runLiveLongHoldTest(tempRoot: string): Promise<void> {
  const target = join(tempRoot, "long-hold", "value.txt");
  await mkdir(join(tempRoot, "long-hold"), { recursive: true });
  await writeFile(target, "", "utf8");
  const readyPath = join(tempRoot, "long-hold", "ready");

  const holder = spawnChild("hold", {
    target,
    tag: "holder",
    holdMs: LONG_HOLD_MS,
    readyPath,
  });

  await waitForFile(readyPath, 15_000);

  // The holder now owns the lock and will hold it past STALE_MS. A waiter must
  // not steal it as stale; it should only run after the holder releases.
  const start = Date.now();
  await withManagedWrite(target, async () => {
    const existing = await readExisting(target);
    await writeFile(target, `${existing}waiter\n`, "utf8");
  });
  const waited = Date.now() - start;

  const holderCode = await holder;
  assert(
    holderCode === 0,
    `Long-hold holder exited with code ${holderCode}; expected a clean exit`,
  );

  const lines = (await readFile(target, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  assert(
    lines.length === 2 && lines[0] === "holder" && lines[1] === "waiter",
    `Long-hold ordering wrong: expected ["holder","waiter"] but read ${JSON.stringify(lines)}; a live long-held lock was stolen`,
  );
  assert(
    waited >= LONG_HOLD_MS - 5_000,
    `Waiter proceeded after only ${waited}ms; it stole a still-live long-held lock instead of waiting`,
  );

  console.log(
    `ok live-long-hold: a ${LONG_HOLD_MS}ms critical section kept its lock alive past STALE_MS`,
  );
}

function spawnAppendChild(
  target: string,
  tag: string,
  appends: number,
): Promise<number | null> {
  return spawnChild("append", { target, tag, appends });
}

function spawnChild(
  kind: "append" | "hold" | "steal",
  options: {
    target: string;
    tag: string;
    appends?: number;
    holdMs?: number;
    readyPath?: string;
  },
): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [CHILD_MODE_ENV]: "1",
      [CHILD_KIND_ENV]: kind,
      [CHILD_TARGET_ENV]: options.target,
      [CHILD_TAG_ENV]: options.tag,
    };
    if (options.appends !== undefined) {
      env[CHILD_COUNT_ENV] = String(options.appends);
    }
    if (options.holdMs !== undefined) {
      env[CHILD_HOLD_MS_ENV] = String(options.holdMs);
    }
    if (options.readyPath !== undefined) {
      env[CHILD_READY_ENV] = options.readyPath;
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx", import.meta.filename],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env,
      },
    );
    child.on("error", rejectExit);
    child.on("exit", (code) => resolveExit(code));
  });
}

function staleLockJson(pid: number): string {
  const heartbeat = Date.now() - 5 * 60_000;
  return `${JSON.stringify({ pid, token: "stale-token", heartbeat })}\n`;
}

async function readExisting(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await delay(50);
  }
  console.error(`FAIL: timed out waiting for ${path}`);
  process.exit(1);
}

async function findDeadPid(): Promise<number> {
  for (let pid = 2 ** 22; pid > 1; pid -= 7919) {
    if (!isProcessAlive(pid)) return pid;
  }
  throw new Error("Could not find a dead pid for the stale-lock test");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "EPERM")) return true;
    if (isErrnoCode(error, "ESRCH")) return false;
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`FAIL: missing required env ${name} in child mode`);
    process.exit(1);
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
