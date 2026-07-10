import {
  access,
  constants,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { migrateDataDir } from "@/lib/migrations/data-dir";
import { assert, withTempDir } from "@/lib/verification/harness";

let capturedDataDir: string | undefined;

try {
  await withTempDir("sandi-data-migration-", async (dataDir) => {
    capturedDataDir = dataDir;
    await seedLegacyV0UserMemory(dataDir);
    await seedLegacyV1Skills(dataDir);
    await seedLegacyV1ConversationMemory(dataDir);
    await seedLegacyConversationManifest(dataDir);

    const first = await migrateDataDir(dataDir);
    assert(
      first.fromVersion === 0,
      "first migration should start at version 0",
    );
    assert(first.toVersion === 2, "first migration should end at version 2");
    assert(first.applied.includes("migrate0to1"), "migrate0to1 should run");
    assert(first.applied.includes("migrate1to2"), "migrate1to2 should run");
    assert(first.backupDir, "legacy data should be backed up");

    const backedUpMemory = await readFile(
      join(first.backupDir, "memory", "user", "123", "MEMORY.md"),
      "utf8",
    );
    assert(
      backedUpMemory === "legacy user memory\n",
      "legacy memory backup should preserve the pre-migration file",
    );
    assert(
      !(await pathExists(join(first.backupDir, "projects"))),
      "backup should not copy unrelated data dir contents",
    );

    const version = await readFile(join(dataDir, ".version"), "utf8");
    assert(version.trim() === "2", ".version should be 2");

    await assertFileContent(
      join(dataDir, "memory", "discord", "123", "MEMORY.md"),
      "legacy user memory\n",
      "legacy user memory should move under discord participant memory",
    );
    assert(
      !(await pathExists(join(dataDir, "memory", "user"))),
      "legacy user memory root should be removed after migration",
    );

    await assertFileContent(
      join(dataDir, "skills", "core", "builtin", "legacy-core", "SKILL.md"),
      legacySkillContent("legacy-core"),
      "legacy core builtin skills should move under core builtin",
    );
    await assertFileContent(
      join(
        dataDir,
        "skills",
        "surfaces",
        "discord",
        "builtin",
        "reminders",
        "SKILL.md",
      ),
      await readFile(
        join(
          process.cwd(),
          "data",
          "skills",
          "surfaces",
          "discord",
          "builtin",
          "reminders",
          "SKILL.md",
        ),
        "utf8",
      ),
      "legacy Discord builtin skills should move under Discord surface builtin and refresh to bundled content",
    );
    assert(
      !(await pathExists(
        join(dataDir, "skills", "core", "builtin", "reminders", "SKILL.md"),
      )),
      "legacy Discord builtin skills should not leak into core builtin",
    );
    await assertFileContent(
      join(dataDir, "skills", "core", "custom", "legacy-custom", "SKILL.md"),
      legacySkillContent("legacy-custom"),
      "legacy custom skills should move under core custom",
    );
    await assertFileContent(
      join(
        dataDir,
        "skills",
        "surfaces",
        "discord",
        "custom",
        "todo-list",
        "SKILL.md",
      ),
      legacySkillContent("todo-list"),
      "legacy Discord custom skills should move under Discord surface custom",
    );
    assert(
      !(await pathExists(
        join(dataDir, "skills", "core", "custom", "todo-list", "SKILL.md"),
      )),
      "legacy Discord custom skills should not leak into core custom",
    );
    assert(
      !(await pathExists(join(dataDir, "skills", "builtin"))),
      "legacy builtin skills root should be removed",
    );
    assert(
      !(await pathExists(join(dataDir, "skills", "custom"))),
      "legacy custom skills root should be removed",
    );

    await assertFileContent(
      join(
        dataDir,
        "memory",
        "surfaces",
        "discord",
        "threads",
        "thread-1",
        "MEMORY.md",
      ),
      "legacy thread memory\n",
      "legacy thread memory should move under Discord surface memory",
    );
    await assertFileContent(
      join(
        dataDir,
        "memory",
        "surfaces",
        "discord",
        "channels",
        "channel-1",
        "MEMORY.md",
      ),
      "legacy channel memory\n",
      "legacy channel memory should move under Discord surface memory",
    );
    assert(
      !(await pathExists(join(dataDir, "memory", "threads"))),
      "legacy threads memory root should be removed",
    );
    assert(
      !(await pathExists(join(dataDir, "memory", "channels"))),
      "legacy channels memory root should be removed",
    );

    const manifest = JSON.parse(
      await readFile(
        join(dataDir, "conversations", "thread-1", "manifest.json"),
        "utf8",
      ),
    );
    assert(manifest.surface === "discord", "manifest should have a surface");
    assert(manifest.platform === "discord", "manifest should have a platform");
    assert(
      manifest.starterParticipantRef === "discord:123",
      "manifest should use participant refs",
    );
    assert(
      manifest.surfaceContext?.threadId === "thread-1",
      "manifest should carry surface context",
    );
    assert(
      manifest.surfacePrompt?.includes("Parent channel conversation ID"),
      "branch manifest should get a Discord surface prompt",
    );
    assert(
      manifest.memoryScopes?.[0]?.refPrefix ===
        "surfaces/discord/threads/thread-1",
      "thread memory scope should be under Discord surface memory",
    );
    assert(
      manifest.memoryScopes?.[1]?.refPrefix ===
        "surfaces/discord/channels/channel-1",
      "parent channel memory scope should be under Discord surface memory",
    );

    const second = await migrateDataDir(dataDir);
    assert(
      second.applied.length === 0,
      "second migration should be idempotent",
    );
    assert(
      !second.backupDir,
      "idempotent migration should not create a backup",
    );

    console.log("data-dir migration verification passed");
  });
} finally {
  if (capturedDataDir !== undefined) {
    await rm(
      join(dirname(capturedDataDir), `${basename(capturedDataDir)}.backups`),
      {
        recursive: true,
        force: true,
      },
    );
  }
}

async function seedLegacyV0UserMemory(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "memory", "user", "123"), { recursive: true });
  await writeFile(
    join(dataDir, "memory", "user", "123", "MEMORY.md"),
    "legacy user memory\n",
    "utf8",
  );
  await mkdir(join(dataDir, "projects", "large-worktree"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "projects", "large-worktree", "README.md"),
    "not part of migration backup\n",
    "utf8",
  );
}

async function seedLegacyV1Skills(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "skills", "builtin", "legacy-core"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "skills", "builtin", "legacy-core", "SKILL.md"),
    legacySkillContent("legacy-core"),
    "utf8",
  );
  await mkdir(join(dataDir, "skills", "builtin", "reminders"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "skills", "builtin", "reminders", "SKILL.md"),
    legacySkillContent("reminders"),
    "utf8",
  );
  await mkdir(join(dataDir, "skills", "custom", "legacy-custom"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "skills", "custom", "legacy-custom", "SKILL.md"),
    legacySkillContent("legacy-custom"),
    "utf8",
  );
  await mkdir(join(dataDir, "skills", "custom", "todo-list"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "skills", "custom", "todo-list", "SKILL.md"),
    legacySkillContent("todo-list"),
    "utf8",
  );
}

async function seedLegacyV1ConversationMemory(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "memory", "threads", "thread-1"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "memory", "threads", "thread-1", "MEMORY.md"),
    "legacy thread memory\n",
    "utf8",
  );
  await mkdir(join(dataDir, "memory", "channels", "channel-1"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "memory", "channels", "channel-1", "MEMORY.md"),
    "legacy channel memory\n",
    "utf8",
  );
}

async function seedLegacyConversationManifest(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "conversations", "thread-1"), {
    recursive: true,
  });
  await writeFile(
    join(dataDir, "conversations", "thread-1", "manifest.json"),
    `${JSON.stringify(
      {
        canonicalId: "discord:guild-1:channel-1:thread-1",
        kind: "thread",
        title: "legacy thread",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        starterUserId: "123",
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        participants: [
          {
            discordUserId: "123",
            username: "casey",
            joinedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        source: {
          kind: "channel_branch",
          parentConversationId: "discord:guild-1:channel-1:room",
          originChannelId: "channel-1",
          originMessageId: "message-1",
          originMessageUrl:
            "https://discord.com/channels/guild-1/channel-1/message-1",
          starterMessage: "hello",
          bridgeSummary: "legacy branch",
          createdByUserId: "123",
        },
        memoryScopes: [
          {
            label: "Current Thread Archive",
            refPrefix: "threads/thread-1",
            area: "current_thread",
          },
          {
            label: "Parent Channel Room",
            refPrefix: "channels/channel-1",
            area: "parent_channel",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function legacySkillContent(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Legacy skill.",
    "---",
    "",
    "# Legacy Skill",
    "",
  ].join("\n");
}

async function assertFileContent(
  path: string,
  expected: string,
  message: string,
): Promise<void> {
  const actual = await readFile(path, "utf8");
  assert(actual === expected, message);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
