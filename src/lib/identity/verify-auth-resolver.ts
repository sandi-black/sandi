import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  findHumanIdentityByPlatformId,
  HumanIdentityStore,
  loadHumanIdentities,
} from "@/lib/identity/resolver";
import type { HumanIdentityConfig } from "@/lib/identity/types";
import { assertEqual, withTempDir } from "@/lib/verification/harness";

async function verifyAuthResolver(): Promise<void> {
  verifyStrictResolverRequiresImmutableId();
  await verifyIdentityStoreHonorsRemoval();
  await verifyDuplicateIdentitiesRejected();
  console.log("auth resolver verification passed");
}

function verifyStrictResolverRequiresImmutableId(): void {
  const identities: HumanIdentityConfig = {
    version: 1,
    humans: [
      {
        id: "jess",
        displayName: "Jess",
        platforms: { discord: { id: "111", username: "jess" } },
      },
      {
        id: "no-id",
        displayName: "Legacy",
        platforms: { discord: { username: "legacy" } },
      },
    ],
  };

  // Resolution must not match when the immutable id differs, even if the
  // username collides. This is the impersonation case.
  const impersonation = findHumanIdentityByPlatformId({
    identities,
    platform: "discord",
    platformUserId: "999",
  });
  assertEqual(
    impersonation,
    undefined,
    "strict resolver rejects username-only match with wrong id",
  );

  // The strict resolver matches on the immutable id.
  const matched = findHumanIdentityByPlatformId({
    identities,
    platform: "discord",
    platformUserId: "111",
  });
  assertEqual(matched?.id, "jess", "strict resolver matches on immutable id");

  // A record configured without an id is not matchable by the strict resolver
  // and so fails closed.
  const noId = findHumanIdentityByPlatformId({
    identities,
    platform: "discord",
    platformUserId: "legacy",
  });
  assertEqual(noId, undefined, "strict resolver rejects record without an id");

  console.log("ok strict resolver requires an immutable platform id");
}

async function verifyIdentityStoreHonorsRemoval(): Promise<void> {
  await withTempDir("sandi-identity-store-", async (dir) => {
    const configDir = join(dir, "config");
    const path = join(configDir, "identities", "humans.json");
    await mkdir(join(configDir, "identities"), { recursive: true });
    await writeIdentities(path, ["jess"]);

    // ttlMs 0 forces a re-stat on every load so the test does not sleep out a
    // cache window; the production default uses a short TTL.
    const store = new HumanIdentityStore([configDir], 0);

    const before = await store.load();
    assertEqual(
      before.humans.some((human) => human.id === "jess"),
      true,
      "identity store loads the configured identity",
    );

    // Remove the identity. The store must reload on the file change so a gate
    // that consults it now fails closed without a restart.
    await writeIdentities(path, []);
    const after = await store.load();
    assertEqual(
      after.humans.length,
      0,
      "identity store drops a removed identity after reload",
    );

    let now = 0;
    await writeIdentities(path, ["jess"]);
    const failClosedStore = new HumanIdentityStore(
      [configDir],
      5_000,
      () => now,
    );
    await failClosedStore.load();
    await writeFile(path, "{", "utf8");
    now = 6_000;
    assertEqual(
      await storeLoadThrows(failClosedStore),
      true,
      "malformed identity reload fails closed",
    );
    now = 6_001;
    assertEqual(
      await storeLoadThrows(failClosedStore),
      true,
      "failed identity reload does not refresh the stale-cache TTL",
    );
    console.log("ok identity store honors removal without restart");
  });
}

async function storeLoadThrows(store: HumanIdentityStore): Promise<boolean> {
  try {
    await store.load();
    return false;
  } catch {
    return true;
  }
}

async function verifyDuplicateIdentitiesRejected(): Promise<void> {
  await withTempDir("sandi-identity-dup-", async (dir) => {
    const configDir = join(dir, "config");
    const path = join(configDir, "identities", "humans.json");
    await mkdir(join(configDir, "identities"), { recursive: true });

    // Two records with the same identity id must fail the load closed.
    await writeRaw(path, {
      version: 1,
      humans: [
        {
          id: "a",
          displayName: "A",
          platforms: { discord: { id: "1", username: "a" } },
        },
        {
          id: "a",
          displayName: "A2",
          platforms: { discord: { id: "2", username: "a2" } },
        },
      ],
    });
    assertEqual(
      await loadThrows([configDir]),
      true,
      "duplicate human id is rejected at load",
    );

    // Two records claiming the same immutable platform id must also fail closed.
    await writeRaw(path, {
      version: 1,
      humans: [
        {
          id: "a",
          displayName: "A",
          platforms: { discord: { id: "1", username: "a" } },
        },
        {
          id: "b",
          displayName: "B",
          platforms: { discord: { id: "1", username: "b" } },
        },
      ],
    });
    assertEqual(
      await loadThrows([configDir]),
      true,
      "duplicate platform id is rejected at load",
    );
    console.log("ok loadHumanIdentities rejects ambiguous duplicate ids");
  });
}

async function loadThrows(configDirs: string[]): Promise<boolean> {
  try {
    await loadHumanIdentities(configDirs);
    return false;
  } catch {
    return true;
  }
}

async function writeRaw(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeIdentities(path: string, ids: string[]): Promise<void> {
  const file: HumanIdentityConfig = {
    version: 1,
    humans: ids.map((id) => ({
      id,
      displayName: id,
      platforms: { discord: { id: `id-${id}`, username: id } },
    })),
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

await verifyAuthResolver();
