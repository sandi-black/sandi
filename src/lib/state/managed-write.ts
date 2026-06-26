import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createLogger } from "../logging";
import { chmodPrivateFile, writePrivateTextFile } from "./private-files";

const log = createLogger("managed-write");

// Concurrent Sandi turns are separate OS processes. Each model turn is its own
// "pi --print" child, sandi_js_run spawns a further tsx grandchild, and every
// surface runs as its own server process. They all share one data/ directory,
// so plain read-modify-write on Sandi's managed state files (memory, skills,
// manifests, events, reminders, feedback, token usage) can lose updates when
// two same-identity processes touch one file at
// once. withManagedWrite serializes the critical section both in-process (a
// promise chain keyed by canonical path) and across processes (an advisory
// lockfile next to the target). It is ONLY for Sandi-managed state under the
// data/ arena, never for user files on a desktop machine.

// A lock is stale only once its heartbeat has not advanced for STALE_MS. The
// holder refreshes the heartbeat every HEARTBEAT_MS while the critical section
// runs, so a live but slow section is never stolen no matter how long it holds
// the lock. STALE_MS must be comfortably larger than HEARTBEAT_MS to tolerate
// scheduler jitter and a missed beat or two.
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
// A malformed or empty lockfile means a holder crashed after creating the lock
// but before writing its metadata. We cannot read a heartbeat from it, so we
// fall back to the file mtime: once it has been untouched for this long we
// recover it. The grace period must exceed STALE_MS so we never race a holder
// that is about to write its first heartbeat.
const MALFORMED_GRACE_MS = STALE_MS + 10_000;
// A waiter must be willing to wait well past STALE_MS: a live holder refreshes
// its heartbeat and is never declared stale, so a critical section that legibly
// runs longer than STALE_MS must not make waiters give up. Keep this a comfortable
// multiple of STALE_MS so only a truly wedged holder (one a stale steal will
// eventually clear) can exhaust it.
const ACQUIRE_TIMEOUT_MS = 120_000;
const BACKOFF_START_MS = 25;
const BACKOFF_CAP_MS = 250;

const inProcessChains = new Map<string, Promise<unknown>>();

// Tracks which canonical keys the current async context already holds, so a
// nested withManagedWrite for the same key runs its critical section directly
// instead of chaining behind the outer section and self-deadlocking.
const heldKeys = new AsyncLocalStorage<Set<string>>();

type LockMetadata = {
  pid: number;
  token: string;
  heartbeat: number;
};

export async function withManagedWrite<T>(
  filePath: string,
  critical: () => Promise<T>,
): Promise<T> {
  const key = await canonicalKey(filePath);
  const held = heldKeys.getStore();
  if (held?.has(key)) {
    // Re-entrant call for a key this async context already holds. The outer
    // section owns the cross-process lock, so run directly: chaining here would
    // wait on the outer section that is itself awaiting us.
    return critical();
  }

  const previous = inProcessChains.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => acquireAndRun(filePath, key, critical),
    () => acquireAndRun(filePath, key, critical),
  );
  inProcessChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await run;
  } finally {
    // Drop the map entry once the chain for this key has fully settled so the
    // map does not grow without bound across many distinct paths.
    const settled = inProcessChains.get(key);
    if (settled !== undefined) {
      settled.then(() => {
        if (inProcessChains.get(key) === settled) {
          inProcessChains.delete(key);
        }
      });
    }
  }
}

export async function atomicWriteManaged(
  filePath: string,
  content: string,
): Promise<void> {
  await withManagedWrite(filePath, () => atomicWriteInPlace(filePath, content));
}

/**
 * Atomic tmp-write plus rename without acquiring the managed-write lock. Use
 * this only from inside a withManagedWrite critical section for the same path
 * (e.g. a read-modify-write that already holds the lock). Acquiring the lock a
 * second time for the same path is safe (it runs directly via the reentrancy
 * guard), but a bare write here avoids the extra bookkeeping.
 */
export async function atomicWriteInPlace(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // A unique temp name avoids colliding with a stale temp from a crashed writer
  // and with any other writer that honors the same final-file lock.
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateTextFile(tempPath, content);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  await chmodPrivateFile(filePath);
}

async function acquireAndRun<T>(
  filePath: string,
  key: string,
  critical: () => Promise<T>,
): Promise<T> {
  const absolutePath = resolve(filePath);
  const lockPath = `${absolutePath}.lock`;
  await mkdir(dirname(absolutePath), { recursive: true });
  const token = await acquireLock(lockPath);
  const heartbeat = startHeartbeat(lockPath, token);
  const held = heldKeys.getStore() ?? new Set<string>();
  held.add(key);

  let result: T;
  try {
    result = await heldKeys.run(held, critical);
  } catch (bodyError) {
    held.delete(key);
    heartbeat.stop();
    // Never let a release failure mask the original body error: log the release
    // failure as context and re-surface the body error.
    try {
      await releaseLock(lockPath, token);
    } catch (releaseError) {
      log.warn("failed to release managed-write lock after critical error", {
        lockPath,
        bodyError: errorMessage(bodyError),
        releaseError: errorMessage(releaseError),
      });
    }
    throw bodyError;
  }

  held.delete(key);
  heartbeat.stop();
  // The body succeeded, so a release failure is the only error to report.
  await releaseLock(lockPath, token);
  return result;
}

type Heartbeat = { stop: () => void };

function startHeartbeat(lockPath: string, token: string): Heartbeat {
  const timer = setInterval(() => {
    // Best-effort refresh: if the rewrite loses a race with a steal we simply
    // stop refreshing. Errors here must never crash the process.
    void writeLock(lockPath, token).catch(() => {});
  }, HEARTBEAT_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}

async function acquireLock(lockPath: string): Promise<string> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let backoff = BACKOFF_START_MS;
  while (true) {
    const token = await tryCreateLock(lockPath);
    if (token !== undefined) return token;
    if (await stealIfStale(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${ACQUIRE_TIMEOUT_MS}ms acquiring managed-write lock: ${lockPath}`,
      );
    }
    await delay(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  }
}

async function tryCreateLock(lockPath: string): Promise<string | undefined> {
  const token = randomUUID();
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(serializeLock({ token, heartbeat: Date.now() }));
    } finally {
      await handle.close();
    }
    await chmodPrivateFile(lockPath);
    return token;
  } catch (error) {
    // EEXIST is the POSIX "already locked" signal. Windows can surface a held
    // or just-created lockfile as EPERM (a sharing violation) rather than
    // EEXIST, so treat both as "not acquired" and fall through to the
    // stale-check and backoff path.
    if (isExistingFileError(error) || isErrnoCode(error, "EPERM")) {
      return undefined;
    }
    throw error;
  }
}

async function writeLock(lockPath: string, token: string): Promise<void> {
  // Only refresh the heartbeat if the lock still belongs to us. Reading then
  // writing is not atomic, but it is only a heartbeat: the worst case is a
  // single stale beat written just after a steal, which the new holder's own
  // beats and the steal protocol's generation check both tolerate.
  const current = await readLock(lockPath);
  if (!current || current.token !== token) return;
  await writePrivateTextFile(
    lockPath,
    serializeLock({ token, heartbeat: Date.now() }),
  );
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  // Only unlink if the lock still carries our token. If it was stolen or
  // replaced, the file now belongs to another holder and must not be removed.
  const current = await readLock(lockPath);
  if (!current || current.token !== token) return;
  await rm(lockPath, { force: true });
}

// Serializes stale steals within this process so two in-process attempts cannot
// both rename-steal the same lock. Cross-process atomicity comes from the
// rename winner check in stealIfStale.
let stealChain: Promise<unknown> = Promise.resolve();

function stealIfStale(lockPath: string): Promise<boolean> {
  const run = stealChain.then(
    () => stealIfStaleUnguarded(lockPath),
    () => stealIfStaleUnguarded(lockPath),
  );
  stealChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function stealIfStaleUnguarded(lockPath: string): Promise<boolean> {
  const before = await readLockRaw(lockPath);
  if (before === undefined) {
    // The holder released the lock between our create attempt and this read.
    // Treat that as progress so the caller retries the create immediately.
    return true;
  }
  if (before.kind === "blocked") {
    // Windows transient sharing violation while the holder is mid-write. Do not
    // steal: back off and retry.
    return false;
  }
  const beforeRaw = before.raw;

  if (!(await isStale(lockPath, beforeRaw))) return false;

  // Atomic steal: rename the lock we judged stale to a unique path. Only one
  // racer can win the rename of a given file. The winner re-reads the renamed
  // bytes and confirms they still match the stale generation it judged, so it
  // never deletes a fresh lock that another process created in the gap, then
  // removes only that renamed file.
  const stolenPath = `${lockPath}.steal.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, stolenPath);
  } catch (error) {
    // Lost the rename race (someone else stole or the holder released and a new
    // holder has not yet created). Either way, retry the create path.
    if (isMissingFileError(error) || isErrnoCode(error, "EPERM")) return true;
    throw error;
  }

  try {
    const after = await readFile(stolenPath, "utf8");
    if (after !== beforeRaw) {
      // The bytes changed between our stale judgement and the rename, so this is
      // a different generation than the one we judged stale. Put it back as best
      // we can and do not treat it as stolen; the create path will re-evaluate.
      await rename(stolenPath, lockPath).catch(() => {});
      return false;
    }
  } catch {
    // If we cannot re-read the renamed file, fall through and remove it: we own
    // it exclusively now, so leaving it would leak a steal-temp.
  }
  await rm(stolenPath, { force: true });
  return true;
}

async function isStale(lockPath: string, raw: string): Promise<boolean> {
  const parsed = parseLock(raw);
  if (!parsed) {
    // A half-written or malformed lockfile means a holder crashed mid-create.
    // We cannot read a heartbeat, so recover it only after the file mtime has
    // gone untouched past the grace period.
    return olderThanMtimeGrace(lockPath);
  }
  if (Date.now() - parsed.heartbeat > STALE_MS) return true;
  return !isProcessAlive(parsed.pid);
}

async function olderThanMtimeGrace(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > MALFORMED_GRACE_MS;
  } catch (error) {
    // Gone already: let the caller retry the create path.
    if (isMissingFileError(error)) return true;
    throw error;
  }
}

type LockRaw = { kind: "read"; raw: string } | { kind: "blocked" };

async function readLockRaw(lockPath: string): Promise<LockRaw | undefined> {
  try {
    return { kind: "read", raw: await readFile(lockPath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    if (isErrnoCode(error, "EPERM")) return { kind: "blocked" };
    throw error;
  }
}

async function readLock(lockPath: string): Promise<LockMetadata | null> {
  try {
    return parseLock(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    if (isErrnoCode(error, "EPERM")) return null;
    throw error;
  }
}

function serializeLock(input: { token: string; heartbeat: number }): string {
  const metadata: LockMetadata = {
    pid: process.pid,
    token: input.token,
    heartbeat: input.heartbeat,
  };
  return `${JSON.stringify(metadata)}\n`;
}

function parseLock(raw: string): LockMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  if (!("pid" in value) || !("token" in value) || !("heartbeat" in value)) {
    return null;
  }
  const pid = value.pid;
  const token = value.token;
  const heartbeat = value.heartbeat;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return null;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof heartbeat !== "number" || !Number.isFinite(heartbeat)) return null;
  return { pid, token, heartbeat };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "EPERM")) return true;
    if (isErrnoCode(error, "ESRCH")) return false;
    // Unknown error: assume alive so we do not steal a live lock.
    return true;
  }
}

async function canonicalKey(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  const real = await canonicalExistingPath(absolutePath);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

async function canonicalExistingPath(absolutePath: string): Promise<string> {
  // realpath resolves symlink aliases so two names for the same file share one
  // in-process chain. The target may not exist yet, so resolve the nearest
  // existing ancestor (the parent dir we are about to create) and re-append the
  // remaining tail.
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return absolutePath;
  const realParent = await canonicalExistingPath(parent);
  return resolve(realParent, absolutePath.slice(parent.length + 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isExistingFileError(error: unknown): boolean {
  return isErrnoCode(error, "EEXIST");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
