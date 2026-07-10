import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";
import { isMissingPathError } from "@/lib/fs-errors";
import {
  type HumanIdentityConfig,
  type HumanIdentityRecord,
  IDENTITY_PLATFORMS,
  type IdentityPlatform,
  PLATFORM_IDENTITY_DESCRIPTORS,
} from "@/lib/identity/types";

const HumanIdentitySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  platforms: z.object({
    discord: z
      .object({
        id: z.string().min(1).optional(),
        username: z.string().min(1),
      })
      .optional(),
    github: z
      .object({
        id: z.string().min(1).optional(),
        login: z.string().min(1),
      })
      .optional(),
  }),
});

const HumanIdentityConfigSchema = z.object({
  version: z.literal(1),
  humans: z.array(HumanIdentitySchema),
});

export async function loadHumanIdentities(
  configDirs: string | readonly string[],
): Promise<HumanIdentityConfig> {
  for (const configDir of normalizeConfigDirs(configDirs)) {
    const path = join(configDir, "identities", "humans.json");
    try {
      const parsed = HumanIdentityConfigSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      assertUniqueIdentities(parsed);
      return parsed;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return { version: 1, humans: [] };
}

/**
 * Rejects a `humans.json` whose entries are ambiguous for auth: two records with
 * the same identity id, or two records claiming the same immutable platform
 * account id. Either would let a strict, id-based auth resolver bind a caller to
 * whichever record happened to come first. Failing the load closed is the safe
 * response to that misconfiguration, the same way a malformed tokens file does.
 */
function assertUniqueIdentities(config: HumanIdentityConfig): void {
  const identityIds = new Set<string>();
  const platformAccountIds = new Map<IdentityPlatform, Set<string>>(
    IDENTITY_PLATFORMS.map((platform) => [platform, new Set<string>()]),
  );
  for (const human of config.humans) {
    const id = human.id.toLowerCase();
    if (identityIds.has(id)) {
      throw new Error(
        `Duplicate human identity id in humans.json: ${human.id}`,
      );
    }
    identityIds.add(id);

    for (const platform of IDENTITY_PLATFORMS) {
      const descriptor = PLATFORM_IDENTITY_DESCRIPTORS[platform];
      const account = descriptor.readAccount(human.platforms);
      const accountId = account?.id?.toLowerCase();
      if (!accountId) continue;
      const seenIds = platformAccountIds.get(platform);
      if (seenIds?.has(accountId)) {
        throw new Error(
          `Duplicate ${descriptor.label} account id in humans.json: ${account?.id}`,
        );
      }
      seenIds?.add(accountId);
    }
  }
}

export function findHumanIdentity(input: {
  identities: HumanIdentityConfig;
  platform: IdentityPlatform;
  platformUserId: string;
  username: string;
}): HumanIdentityRecord | undefined {
  const username = input.username.toLowerCase();
  const platformUserId = input.platformUserId.toLowerCase();
  const descriptor = PLATFORM_IDENTITY_DESCRIPTORS[input.platform];
  return input.identities.humans.find((human) => {
    const account = descriptor.readAccount(human.platforms);
    if (!account) return false;
    if (account.id && account.id.toLowerCase() === platformUserId) return true;
    return account.username.toLowerCase() === username;
  });
}

/**
 * Strict, auth-grade identity resolution: matches only on the immutable platform
 * account id, never on a mutable username. Use this for security gates that mint
 * credentials (device pairing), where matching a reassignable username could let
 * a different account impersonate a configured identity. A record configured
 * without an immutable id for the platform is not matchable here and so fails
 * closed: an operator must add the id before that human can enroll a device.
 */
export function findHumanIdentityByPlatformId(input: {
  identities: HumanIdentityConfig;
  platform: IdentityPlatform;
  platformUserId: string;
}): HumanIdentityRecord | undefined {
  const platformUserId = input.platformUserId.toLowerCase();
  const descriptor = PLATFORM_IDENTITY_DESCRIPTORS[input.platform];
  return input.identities.humans.find((human) => {
    const account = descriptor.readAccount(human.platforms);
    if (!account?.id) return false;
    return account.id.toLowerCase() === platformUserId;
  });
}

/**
 * Caches the parsed identities and reloads them whenever any candidate
 * `humans.json` changes (mtime or size), bounded by a short TTL. This keeps
 * auth-critical gates fresh: an identity removed or unmapped by an operator
 * stops authenticating without a process restart, mirroring how `ApiTokenStore`
 * honors token revocation. It avoids re-reading the file on every single call.
 */
export class HumanIdentityStore {
  readonly #configDirs: string[];
  readonly #ttlMs: number;
  #cache: HumanIdentityConfig = { version: 1, humans: [] };
  #cacheKey: string | undefined;
  #checkedAt = 0;

  constructor(configDirs: string | readonly string[], ttlMs = 5_000) {
    this.#configDirs = normalizeConfigDirs(configDirs);
    this.#ttlMs = ttlMs;
  }

  async load(): Promise<HumanIdentityConfig> {
    const now = Date.now();
    if (
      this.#ttlMs > 0 &&
      this.#cacheKey !== undefined &&
      now - this.#checkedAt < this.#ttlMs
    ) {
      return this.#cache;
    }
    // Stat before reading so we never cache older content under a newer key: the
    // content read is always at least as new as the key, and any later change
    // bumps the key and forces a reload. A non-positive TTL re-stats on every
    // call, which is what auth gates use for immediate revocation. (Same
    // ordering as ApiTokenStore.)
    const key = await this.#statKey();
    this.#checkedAt = now;
    if (this.#cacheKey === key) return this.#cache;
    this.#cache = await loadHumanIdentities(this.#configDirs);
    this.#cacheKey = key;
    return this.#cache;
  }

  async #statKey(): Promise<string> {
    const parts: string[] = [];
    for (const configDir of this.#configDirs) {
      const path = join(configDir, "identities", "humans.json");
      try {
        const info = await stat(path);
        parts.push(`${info.mtimeMs}:${info.size}`);
      } catch (error) {
        if (isMissingPathError(error)) {
          parts.push("missing");
          continue;
        }
        throw error;
      }
    }
    return parts.join("|");
  }
}

function normalizeConfigDirs(configDirs: string | readonly string[]): string[] {
  return typeof configDirs === "string" ? [configDirs] : [...configDirs];
}
