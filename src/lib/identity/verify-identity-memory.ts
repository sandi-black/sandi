import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildMemoryContext, loadMemory } from "@/lib/context/memory";
import type { ConversationParticipant } from "@/lib/conversations/types";
import {
  findHumanIdentityByPlatformId,
  loadHumanIdentities,
} from "@/lib/identity/resolver";
import { participantMemoryRef } from "@/lib/identity/types";
import { assert, withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-identity-memory-", async (tempRoot) => {
  const configDir = join(tempRoot, "config");
  const dataDir = join(tempRoot, "data");
  await mkdir(join(configDir, "identities"), { recursive: true });
  await writeFile(
    join(configDir, "identities", "humans.json"),
    JSON.stringify(
      {
        version: 1,
        humans: [
          {
            id: "casey",
            displayName: "Casey",
            platforms: {
              discord: {
                id: "discord-user-casey",
                username: "casey-discord",
              },
              github: {
                id: "22222222",
                login: "casey-github",
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const identities = await loadHumanIdentities(configDir);
  const discordIdentity = findHumanIdentityByPlatformId({
    identities,
    platform: "discord",
    platformUserId: "discord-user-casey",
  });
  const githubIdentity = findHumanIdentityByPlatformId({
    identities,
    platform: "github",
    platformUserId: "22222222",
  });
  assert(discordIdentity?.id === "casey", "Discord Casey should map to Casey");
  assert(githubIdentity?.id === "casey", "GitHub Casey should map to Casey");

  const discordCasey: ConversationParticipant = {
    platform: "discord",
    platformUserId: "discord-user-casey",
    username: "casey-discord",
    displayName: "Casey",
    identityId: "casey",
    joinedAt: "2026-05-20T00:00:00.000Z",
  };
  const githubCasey: ConversationParticipant = {
    platform: "github",
    platformUserId: "22222222",
    username: "casey-github",
    displayName: "Casey",
    identityId: "casey",
    joinedAt: "2026-05-20T00:00:00.000Z",
  };

  assert(
    participantMemoryRef(discordCasey) === "discord/discord-user-casey",
    "Discord participant memory ref should use the Discord platform ID",
  );
  assert(
    participantMemoryRef(githubCasey) === "github/22222222",
    "GitHub participant memory ref should use the GitHub platform ID",
  );

  await mkdir(join(dataDir, "memory", "discord", "discord-user-casey"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "memory", "discord", "discord-user-casey", "MEMORY.md"),
    "discord-only memory\n",
    "utf8",
  );
  await mkdir(join(dataDir, "memory", "github", "22222222"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "memory", "github", "22222222", "MEMORY.md"),
    "github-only memory\n",
    "utf8",
  );

  const discordMemory = await loadMemory(
    buildMemoryContext({
      dataDir,
      participants: [discordCasey],
    }),
  );
  assert(
    discordMemory.includes("discord/discord-user-casey/MEMORY.md"),
    "Discord turn should expose Discord Casey memory ref",
  );
  assert(
    discordMemory.includes("discord-only memory"),
    "Discord turn should expose Discord Casey memory content",
  );
  assert(
    !discordMemory.includes("github-only memory"),
    "Discord-only turn should not expose GitHub Casey memory content",
  );

  const crossSurfaceMemory = await loadMemory(
    buildMemoryContext({
      dataDir,
      participants: [discordCasey, githubCasey],
    }),
  );
  assert(
    crossSurfaceMemory.includes("discord-only memory") &&
      crossSurfaceMemory.includes("github-only memory"),
    "When both platform participants are active, both memory arenas should be visible",
  );

  console.log("identity and memory verification passed");
});
