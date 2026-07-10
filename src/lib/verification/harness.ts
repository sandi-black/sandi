import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Shared scaffolding for the src/**\/verify-*.ts scripts, which run standalone
 * via tsx with no test-runner assertion library behind them. Every helper
 * here throws rather than logging and calling process.exit directly, so a
 * script's own top-level `.catch` is the single place that reports failure
 * and sets the exit code.
 */

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Deep-equal rather than reference-equal: verify scripts routinely compare
 * parsed JSON bodies and constructed records, where two structurally
 * identical values are not the same reference.
 */
export function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (isDeepStrictEqual(actual, expected)) return;
  throw new Error(
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Creates a scratch directory under the OS temp dir, hands it to `run`, and
 * always removes it afterward, even if `run` throws.
 */
export async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
