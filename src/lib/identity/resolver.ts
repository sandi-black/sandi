import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";
import type {
  HumanIdentityConfig,
  HumanIdentityRecord,
  IdentityPlatform,
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
  let lastMissingError: unknown;
  for (const configDir of normalizeConfigDirs(configDirs)) {
    const path = join(configDir, "identities", "humans.json");
    try {
      return HumanIdentityConfigSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      lastMissingError = error;
    }
  }
  if (lastMissingError) return { version: 1, humans: [] };
  return { version: 1, humans: [] };
}

export function findHumanIdentity(input: {
  identities: HumanIdentityConfig;
  platform: IdentityPlatform;
  platformUserId: string;
  username: string;
}): HumanIdentityRecord | undefined {
  const username = input.username.toLowerCase();
  const platformUserId = input.platformUserId.toLowerCase();
  return input.identities.humans.find((human) => {
    const account = human.platforms[input.platform];
    if (!account) return false;
    if (account.id && account.id.toLowerCase() === platformUserId) return true;
    if (input.platform === "discord" && "username" in account) {
      return account.username.toLowerCase() === username;
    }
    if (input.platform === "github" && "login" in account) {
      return account.login.toLowerCase() === username;
    }
    return false;
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeConfigDirs(configDirs: string | readonly string[]): string[] {
  return typeof configDirs === "string" ? [configDirs] : [...configDirs];
}
