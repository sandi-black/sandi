import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";
import { readEnv } from "@/lib/config/env";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";

// A pairing code is a short-lived, single-use secret that an identity-bearing
// surface hands to a human so a thin client (a desktop, say) can prove which
// human identity it speaks for. The code resolves to an `identityId`, which
// already spans every platform mapping that identity carries, so redeeming a
// code binds the client to the whole identity, not to one surface account. The
// client exchanges the code for a long-lived per-device bearer token.
//
// This store is platform-neutral: it never knows or records which surface issued
// a code. The issuing surface resolves the human to an identity first and stores
// only the resulting `identityId`.

// Codes live just long enough to walk from one app to another, then expire.
export const PAIRING_TTL_MS = 10 * 60_000;

// Crockford base32 alphabet: 32 unambiguous symbols (no I, L, O, or U). 256 is
// an exact multiple of 32, so `byte & 31` selects a symbol with no modulo bias.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Timestamps are epoch milliseconds, parsed to a number at the boundary so the
// rest of the code compares them directly and never reparses a string at use.
const ApiPairingSchema = z.object({
  codeSha256: z.string().regex(SHA256_HEX, "codeSha256 must be 64 hex chars"),
  identityId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

const ApiPairingsFileSchema = z.object({
  version: z.literal(1),
  pairings: z.array(ApiPairingSchema),
});

export type ApiPairing = z.infer<typeof ApiPairingSchema>;
export type ApiPairingsFile = z.infer<typeof ApiPairingsFileSchema>;

const EMPTY_PAIRINGS: ApiPairingsFile = { version: 1, pairings: [] };

export function defaultApiPairingsPath(dataDir: string): string {
  return (
    readEnv(["SANDI_API_PAIRINGS_PATH"]) ??
    join(dataDir, "config", "api-pairings.json")
  );
}

/**
 * Generates a fresh code. Returns the canonical `code` (used for hashing and
 * redemption) and a `display` form grouped for readability. The raw code is
 * returned to the caller exactly once and is never persisted; only its hash is
 * stored.
 */
export function generatePairingCode(): { code: string; display: string } {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CROCKFORD[byte & 31];
  }
  const display = `${code.slice(0, 5)}-${code.slice(5)}`;
  return { code, display };
}

/**
 * Normalizes a user-typed code to its canonical form: upper-cases, drops spaces
 * and grouping dashes, and folds the visually ambiguous letters a human might
 * type (O for zero, I or L for one) back onto the canonical symbols. Returns
 * undefined for input that is not a well-formed code, so a malformed redemption
 * is rejected without revealing which part was wrong.
 */
export function normalizePairingCode(raw: string): string | undefined {
  const stripped = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
  const folded = stripped.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (folded.length !== CODE_LENGTH) return undefined;
  for (const character of folded) {
    if (!CROCKFORD.includes(character)) return undefined;
  }
  return folded;
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export async function loadApiPairings(path: string): Promise<ApiPairingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_PAIRINGS;
    throw error;
  }
  // A malformed pairings file must fail closed rather than silently dropping
  // every pending code or, worse, accepting a weak entry. Throwing surfaces
  // operator error instead of degrading enrollment.
  return ApiPairingsFileSchema.parse(JSON.parse(raw));
}

/**
 * Issues a new pairing code for an identity under the managed-write lock. The
 * write also prunes expired codes and supersedes any prior unconsumed code for
 * the same identity, so re-running the issuing command always replaces the last
 * code rather than leaving several live at once.
 */
export async function createPairing(input: {
  path: string;
  identityId: string;
  now?: number;
  ttlMs?: number;
}): Promise<{ code: string; display: string }> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? PAIRING_TTL_MS;

  let issued: { code: string; display: string } | undefined;
  await withManagedWrite(input.path, async () => {
    const current = await loadApiPairings(input.path);
    // Keep only live codes, and drop any prior code for this identity so a new
    // issue supersedes the last. Generating inside the lock lets us guarantee
    // the new code does not collide with another live code (astronomically
    // unlikely at 50 bits, but then redemption would be ambiguous).
    const live = current.pairings.filter((pairing) => !isExpired(pairing, now));
    const candidate = generateUniqueCode(live);
    issued = candidate;
    const record: ApiPairing = {
      codeSha256: hashPairingCode(candidate.code),
      identityId: input.identityId,
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
    };
    const kept = live.filter(
      (pairing) => pairing.identityId !== input.identityId,
    );
    const next: ApiPairingsFile = {
      version: 1,
      pairings: [...kept, record],
    };
    await atomicWriteInPlace(input.path, `${JSON.stringify(next, null, 2)}\n`);
  });

  if (!issued) throw new Error("pairing code generation failed");
  return { code: issued.code, display: issued.display };
}

function generateUniqueCode(live: readonly ApiPairing[]): {
  code: string;
  display: string;
} {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = generatePairingCode();
    const hash = hashPairingCode(candidate.code);
    if (!live.some((pairing) => pairing.codeSha256 === hash)) return candidate;
  }
  // 16 consecutive collisions against a handful of live 50-bit codes is not
  // reachable with a working RNG. If it somehow happens, throw rather than
  // return an unchecked (possibly duplicate) code.
  throw new Error("could not generate a unique pairing code");
}

/**
 * Atomically redeems a code under the managed-write lock and returns the bound
 * identity. The matched code is removed in the same critical section, so the
 * code is single-use even when two clients race to redeem it: only the process
 * that wins the lock and finds the code still present consumes it. Expired codes
 * are pruned on the way through. Returns undefined for an unknown or expired
 * code so the caller can reject it.
 */
export async function consumePairing(input: {
  path: string;
  code: string;
  now?: number;
}): Promise<{ identityId: string } | undefined> {
  const now = input.now ?? Date.now();
  const codeSha256 = hashPairingCode(input.code);

  return withManagedWrite(input.path, async () => {
    const current = await loadApiPairings(input.path);
    let consumed: ApiPairing | undefined;
    const remaining: ApiPairing[] = [];
    for (const pairing of current.pairings) {
      if (isExpired(pairing, now)) continue;
      if (!consumed && hexEquals(pairing.codeSha256, codeSha256)) {
        consumed = pairing;
        continue;
      }
      remaining.push(pairing);
    }

    if (
      consumed === undefined &&
      remaining.length === current.pairings.length
    ) {
      // Nothing matched and nothing expired: leave the file untouched.
      return undefined;
    }

    const next: ApiPairingsFile = { version: 1, pairings: remaining };
    await atomicWriteInPlace(input.path, `${JSON.stringify(next, null, 2)}\n`);
    return consumed ? { identityId: consumed.identityId } : undefined;
  });
}

function isExpired(pairing: ApiPairing, now: number): boolean {
  return pairing.expiresAtMs <= now;
}

// Constant-time comparison over the hex digests of equal length. The stored and
// presented values are both validated 64-char hex, so length is equal by
// construction and the comparison never short-circuits on content.
function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
