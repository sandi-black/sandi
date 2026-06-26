import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { z } from "zod/v4";

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
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
