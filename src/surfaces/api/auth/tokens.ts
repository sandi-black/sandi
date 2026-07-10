import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { z } from "zod/v4";
import { isMissingFileError } from "@/lib/fs-errors";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const ApiTokenEntrySchema = z.object({
  tokenSha256: z.string().regex(SHA256_HEX, "tokenSha256 must be 64 hex chars"),
  identityId: z.string().min(1),
  deviceId: z.string().min(1),
  label: z.string().min(1),
});

const ApiTokensFileSchema = z.object({
  version: z.literal(1),
  tokens: z.array(ApiTokenEntrySchema),
});

export type ApiTokenEntry = z.infer<typeof ApiTokenEntrySchema>;
export type ApiTokensFile = z.infer<typeof ApiTokensFileSchema>;

const EMPTY_TOKENS: ApiTokensFile = { version: 1, tokens: [] };

export async function loadApiTokens(path: string): Promise<ApiTokensFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_TOKENS;
    throw error;
  }
  // A malformed token file (bad JSON or a schema violation such as a short or
  // non-hex digest) must fail closed rather than silently authenticating no
  // one or, worse, accepting a weak entry. Throwing here surfaces operator
  // error instead of degrading auth.
  return ApiTokensFileSchema.parse(JSON.parse(raw));
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// A raw bearer token is 32 random bytes rendered as 64 hex characters. Only its
// SHA-256 hash is ever written to disk; the raw value is returned to the caller
// exactly once and must never be logged.
const TOKEN_BYTES = 32;

/**
 * Appends a token entry to the tokens file under the managed-write lock, so a
 * concurrent enrollment (from the CLI or the pairing endpoint, possibly in
 * another process) cannot clobber an entry. The file is written with private
 * permissions because it gates authentication.
 */
export async function appendApiTokenEntry(
  tokensPath: string,
  entry: ApiTokenEntry,
): Promise<void> {
  await withManagedWrite(tokensPath, async () => {
    const current = await loadApiTokens(tokensPath);
    const next: ApiTokensFile = {
      version: 1,
      tokens: [...current.tokens, entry],
    };
    await atomicWriteInPlace(tokensPath, `${JSON.stringify(next, null, 2)}\n`);
  });
}

/**
 * Mints a new per-device bearer token bound to an identity, persists only its
 * hash, and returns the raw token once. The caller is responsible for having
 * already validated that the identity exists and is mappable.
 */
export async function mintApiToken(input: {
  tokensPath: string;
  identityId: string;
  deviceId: string;
  label: string;
}): Promise<string> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const entry: ApiTokenEntry = {
    tokenSha256: hashApiToken(rawToken),
    identityId: input.identityId,
    deviceId: input.deviceId,
    label: input.label,
  };
  await appendApiTokenEntry(input.tokensPath, entry);
  return rawToken;
}

/**
 * Hashes the presented bearer token and finds a matching entry using a
 * constant-time comparison over the hex digests. Every stored entry is scanned
 * with `timingSafeEqual` (no early return on the first match) so neither the
 * match position nor the number of entries leaks through timing. Returns the
 * matched entry or undefined. Never logs or echoes the raw token.
 */
export function verifyBearer(
  token: string,
  tokens: ApiTokensFile,
): ApiTokenEntry | undefined {
  // The presented value must itself be a valid token shape before we spend any
  // comparison on it; the stored digests are already validated to 64 hex chars.
  const presented = Buffer.from(hashApiToken(token), "utf8");
  let matched: ApiTokenEntry | undefined;
  for (const entry of tokens.tokens) {
    const stored = Buffer.from(entry.tokenSha256, "utf8");
    // Lengths are equal by construction (both are 64-char hex digests), so the
    // comparison runs for every entry and only records the match afterwards.
    if (
      stored.length === presented.length &&
      timingSafeEqual(stored, presented)
    ) {
      matched = entry;
    }
  }
  return matched;
}

/**
 * Caches the parsed token file and reloads it whenever the file's mtime or size
 * changes, bounded by a short TTL. This keeps revocation and enrollment fast
 * (no process restart) without re-reading the file on every single request.
 */
export class ApiTokenStore {
  readonly #path: string;
  readonly #ttlMs: number;
  #cache: ApiTokensFile = EMPTY_TOKENS;
  #cacheKey: string | undefined;
  #checkedAt = 0;

  constructor(path: string, ttlMs = 5_000) {
    this.#path = path;
    this.#ttlMs = ttlMs;
  }

  async verify(token: string): Promise<ApiTokenEntry | undefined> {
    return verifyBearer(token, await this.#load());
  }

  async #load(): Promise<ApiTokensFile> {
    const now = Date.now();
    // A non-positive TTL disables caching entirely: always reload. This keeps
    // revocation immediate in tests and is a safe (if slower) production
    // setting. With a positive TTL we serve the cache until it expires, then
    // re-stat and only re-read when mtime or size changed.
    if (this.#ttlMs > 0 && this.#cacheKey !== undefined) {
      if (now - this.#checkedAt < this.#ttlMs) return this.#cache;
      const key = await this.#statKey();
      this.#checkedAt = now;
      if (key === this.#cacheKey) return this.#cache;
      this.#cache = await loadApiTokens(this.#path);
      this.#cacheKey = key;
      return this.#cache;
    }
    this.#cache = await loadApiTokens(this.#path);
    this.#cacheKey = await this.#statKey();
    this.#checkedAt = now;
    return this.#cache;
  }

  async #statKey(): Promise<string> {
    try {
      const info = await stat(this.#path);
      return `${info.mtimeMs}:${info.size}`;
    } catch (error) {
      if (isMissingFileError(error)) return "missing";
      throw error;
    }
  }
}
