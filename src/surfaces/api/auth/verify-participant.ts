import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadHumanIdentities } from "@/lib/identity/resolver";
import { withTempDir } from "@/lib/verification/harness";
import { apiParticipantFromHuman } from "@/surfaces/api/auth/participant";

await withTempDir("sandi-api-participant-", async (root) => {
  const configDir = join(root, "config");
  const identitiesDir = join(configDir, "identities");
  await mkdir(identitiesDir, { recursive: true });

  await writeIdentities(identitiesDir, [
    {
      id: "ada",
      displayName: "Ada Lovelace",
      primaryPlatform: "github",
      platforms: {
        discord: { id: "111", username: "ada-discord" },
        github: { id: "222", login: "ada-github" },
      },
    },
    {
      id: "grace",
      displayName: "Grace Hopper",
      platforms: {
        discord: { id: "333", username: "grace-discord" },
        github: { id: "444", login: "grace-github" },
      },
    },
  ]);

  const identities = await loadHumanIdentities(configDir);
  const ada = identities.humans.find((human) => human.id === "ada");
  const grace = identities.humans.find((human) => human.id === "grace");
  assert(ada, "configured GitHub-primary identity should load");
  assert(grace, "legacy identity should load");

  const adaParticipant = apiParticipantFromHuman(ada);
  assert.equal(adaParticipant?.platform, "github");
  assert.equal(adaParticipant?.platformUserId, "222");
  assert.equal(adaParticipant?.username, "ada-github");

  const graceParticipant = apiParticipantFromHuman(grace);
  assert.equal(graceParticipant?.platform, "discord");
  assert.equal(graceParticipant?.platformUserId, "333");

  await writeIdentities(identitiesDir, [
    {
      id: "anna",
      displayName: "Anna Winlock",
      primaryPlatform: "github",
      platforms: {
        discord: { id: "555", username: "anna-discord" },
      },
    },
  ]);
  await assert.rejects(
    loadHumanIdentities(configDir),
    /primaryPlatform must have a matching account/u,
  );

  await writeIdentities(identitiesDir, [
    {
      id: "katherine",
      displayName: "Katherine Johnson",
      primaryPlatform: "api",
      platforms: {
        discord: { id: "666", username: "katherine-discord" },
      },
    },
  ]);
  await assert.rejects(
    loadHumanIdentities(configDir),
    /primaryPlatform must name a supported identity platform/u,
  );
});

console.log("API participant identity verification passed");

async function writeIdentities(
  identitiesDir: string,
  humans: unknown[],
): Promise<void> {
  await writeFile(
    join(identitiesDir, "humans.json"),
    `${JSON.stringify({ version: 1, humans }, null, 2)}\n`,
    "utf8",
  );
}
