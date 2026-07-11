import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { z } from "zod/v4";
import { isMissingPathError } from "@/lib/fs-errors";
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

const ApiTokensFileSchema = z
  .object({
    version: z.literal(1),
    tokens: z.array(ApiTokenEntrySchema),
  })
  .superRefine((file, context) => {
    const hashes = new Set<string>();
    for (const [index, token] of file.tokens.entries()) {
      if (hashes.has(token.tokenSha256)) {
        context.addIssue({
          code: "custom",
          message: "tokenSha256 must be unique",
          path: ["tokens", index, "tokenSha256"],
        });
      }
      hashes.add(token.tokenSha256);
    }
  });

export type ApiTokenEntry = z.infer<typeof ApiTokenEntrySchema>;
export type ApiTokensFile = z.infer<typeof ApiTokensFileSchema>;

const EMPTY_TOKENS: ApiTokensFile = { version: 1, tokens: [] };

export async function loadApiTokens(path: string): Promise<ApiTokensFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return EMPTY_TOKENS;
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

// A raw bearer token is 32 random bytes rendered as 64 hex characters. The
// token store persists only its SHA-256 hash. Pairing redemption temporarily
// journals the raw value in its private transaction file so a retry can recover
// the same credential. Raw tokens must never be logged.
const TOKEN_BYTES = 32;

export function generateApiToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function apiTokenEntry(input: {
  token: string;
  identityId: string;
  deviceId: string;
  label: string;
}): ApiTokenEntry {
  return ApiTokenEntrySchema.parse({
    tokenSha256: hashApiToken(input.token),
    identityId: input.identityId,
    deviceId: input.deviceId,
    label: input.label,
  });
}

export async function apiTokenEntryExists(
  tokensPath: string,
  entry: ApiTokenEntry,
): Promise<boolean> {
  return (await loadApiTokens(tokensPath)).tokens.some((candidate) =>
    sameApiTokenEntry(candidate, entry),
  );
}

/**
 * Persists a token entry under the managed-write lock. Repeating the exact
 * entry succeeds without writing a duplicate, which lets pairing recovery
 * resume after an ambiguous process exit. Reusing a hash with different
 * metadata fails closed. The file is private because it gates authentication.
 */
export async function appendApiTokenEntry(
  tokensPath: string,
  entry: ApiTokenEntry,
): Promise<void> {
  await withManagedWrite(tokensPath, async () => {
    const current = await loadApiTokens(tokensPath);
    const sameHash = current.tokens.find(
      (candidate) => candidate.tokenSha256 === entry.tokenSha256,
    );
    if (sameHash) {
      if (sameApiTokenEntry(sameHash, entry)) return;
      throw new Error("API token hash already exists with different metadata");
    }
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
  const rawToken = generateApiToken();
  const entry = apiTokenEntry({ token: rawToken, ...input });
  await appendApiTokenEntry(input.tokensPath, entry);
  return rawToken;
}

function sameApiTokenEntry(left: ApiTokenEntry, right: ApiTokenEntry): boolean {
  return (
    left.tokenSha256 === right.tokenSha256 &&
    left.identityId === right.identityId &&
    left.deviceId === right.deviceId &&
    left.label === right.label
  );
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
  readonly #now: () => number;
  #cache: ApiTokensFile = EMPTY_TOKENS;
  #cacheKey: string | undefined;
  #checkedAt = 0;
  readonly #listeners = new Set<(tokens: ApiTokensFile) => void>();

  constructor(path: string, ttlMs = 5_000, now: () => number = Date.now) {
    this.#path = path;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  async verify(token: string): Promise<ApiTokenEntry | undefined> {
    return verifyBearer(token, await this.#load());
  }

  async contains(entry: ApiTokenEntry): Promise<boolean> {
    const tokens = await this.#load();
    return tokens.tokens.some((candidate) =>
      sameApiTokenEntry(candidate, entry),
    );
  }

  onChange(listener: (tokens: ApiTokensFile) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #load(): Promise<ApiTokensFile> {
    const now = this.#now();
    // A non-positive TTL disables caching entirely: always reload. This keeps
    // revocation immediate in tests and is a safe (if slower) production
    // setting. With a positive TTL we serve the cache until it expires, then
    // re-stat and only re-read when mtime or size changed.
    if (this.#ttlMs <= 0) {
      return this.#reload(await this.#statKey(), now);
    }
    if (this.#ttlMs > 0 && this.#cacheKey !== undefined) {
      if (now - this.#checkedAt < this.#ttlMs) return this.#cache;
      const key = await this.#statKey();
      if (key === this.#cacheKey) {
        this.#checkedAt = now;
        return this.#cache;
      }
      return this.#reload(key, now);
    }
    return this.#reload(await this.#statKey(), now);
  }

  async #reload(key: string, now: number): Promise<ApiTokensFile> {
    let loaded: ApiTokensFile;
    try {
      loaded = await loadApiTokens(this.#path);
    } catch (error) {
      // Existing device streams must fail closed with request authentication.
      // A malformed or unreadable authorization source cannot leave a device
      // authorized from an older snapshot.
      this.#notify(EMPTY_TOKENS);
      throw error;
    }
    this.#cache = loaded;
    this.#cacheKey = key;
    this.#checkedAt = now;
    this.#notify(loaded);
    return loaded;
  }

  #notify(tokens: ApiTokensFile): void {
    for (const listener of this.#listeners) listener(tokens);
  }

  async #statKey(): Promise<string> {
    try {
      const info = await stat(this.#path, { bigint: true });
      return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    } catch (error) {
      if (isMissingPathError(error)) return "missing";
      throw error;
    }
  }
}
