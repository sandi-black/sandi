import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isMissingPathError } from "@/lib/fs-errors";
import { isRecord } from "@/lib/type-guards";

export const CURRENT_DATA_DIR_VERSION = 2;

export type MigrationResult = {
  fromVersion: number;
  toVersion: number;
  backupDir?: string;
  applied: string[];
};

type MigrationLogger = {
  info(message: string, details?: Record<string, unknown>): void;
};

const DISCORD_SURFACE_BUILTIN_SKILLS = new Set([
  "discord-participation",
  "image-generation",
  "reminders",
  "temporal-continuity",
]);

const DISCORD_SURFACE_CUSTOM_SKILLS = new Set(["todo-list"]);

export async function migrateDataDir(
  dataDir: string,
  options: { logger?: MigrationLogger } = {},
): Promise<MigrationResult> {
  const fromVersion = await readDataDirVersion(dataDir);
  if (fromVersion > CURRENT_DATA_DIR_VERSION) {
    throw new Error(
      `Data dir version ${fromVersion} is newer than supported version ${CURRENT_DATA_DIR_VERSION}.`,
    );
  }
  if (fromVersion === CURRENT_DATA_DIR_VERSION) {
    return { fromVersion, toVersion: fromVersion, applied: [] };
  }

  let backupDir: string | undefined;
  const applied: string[] = [];
  let version = fromVersion;
  if (version === 0) {
    if (await pathExists(join(dataDir, "memory", "user"))) {
      backupDir = await backupDirForMigration(dataDir, fromVersion, [
        "memory",
        "skills",
        "conversations",
      ]);
      options.logger?.info("backed up data roots before migration", {
        dataDir,
        backupDir,
        fromVersion,
        toVersion: CURRENT_DATA_DIR_VERSION,
      });
    }
    await migrate0to1(dataDir);
    version = 1;
    applied.push("migrate0to1");
    await writeDataDirVersion(dataDir, version);
  }
  if (version === 1) {
    if (await needsMigration1to2(dataDir)) {
      backupDir ??= await backupDirForMigration(dataDir, version, [
        "memory",
        "skills",
        "conversations",
      ]);
      options.logger?.info("backed up data roots before migration", {
        dataDir,
        backupDir,
        fromVersion: version,
        toVersion: 2,
      });
    }
    await migrate1to2(dataDir);
    version = 2;
    applied.push("migrate1to2");
    await writeDataDirVersion(dataDir, version);
  }

  const result: MigrationResult = {
    fromVersion,
    toVersion: version,
    applied,
  };
  if (backupDir) result.backupDir = backupDir;
  return result;
}

export async function readDataDirVersion(dataDir: string): Promise<number> {
  try {
    const raw = await readFile(join(dataDir, ".version"), "utf8");
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new Error(
        `Invalid data dir version file: ${join(dataDir, ".version")}`,
      );
    }
    return parsed;
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
}

async function writeDataDirVersion(
  dataDir: string,
  version: number,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, ".version"), `${version}\n`, "utf8");
}

async function backupDirForMigration(
  dataDir: string,
  fromVersion: number,
  roots: readonly string[],
): Promise<string | undefined> {
  const existingRoots = [];
  for (const root of roots) {
    if (await pathExists(join(dataDir, root))) existingRoots.push(root);
  }
  if (existingRoots.length === 0) return undefined;

  const backupRoot = join(dirname(dataDir), `${basename(dataDir)}.backups`);
  await mkdir(backupRoot, { recursive: true });
  const backupDir = join(
    backupRoot,
    `data-${timestampForPath()}-v${fromVersion}-to-v${CURRENT_DATA_DIR_VERSION}`,
  );
  await mkdir(backupDir, { recursive: true });
  for (const root of existingRoots) {
    await cp(join(dataDir, root), join(backupDir, root), { recursive: true });
  }
  return backupDir;
}

export async function migrate0to1(dataDir: string): Promise<void> {
  const legacyUserRoot = join(dataDir, "memory", "user");
  if (!(await pathExists(legacyUserRoot))) return;

  const entries = await readdir(legacyUserRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(legacyUserRoot, entry.name);
    const target = join(dataDir, "memory", "discord", entry.name);
    await copyTreeWithoutOverwrite({
      source,
      target,
      conflictRoot: join(
        dataDir,
        "memory",
        ".migration-conflicts",
        "v0-user-to-discord",
        entry.name,
      ),
    });
  }
  await rm(legacyUserRoot, { recursive: true, force: true });
}

export async function migrate1to2(dataDir: string): Promise<void> {
  await migrateLegacyBuiltinSkills1to2(dataDir);
  await migrateLegacyCustomSkills1to2(dataDir);
  await moveLegacyTree({
    source: join(dataDir, "memory", "threads"),
    target: join(dataDir, "memory", "surfaces", "discord", "threads"),
    conflictRoot: join(
      dataDir,
      "memory",
      ".migration-conflicts",
      "v1-discord-conversation-memory",
      "threads",
    ),
  });
  await moveLegacyTree({
    source: join(dataDir, "memory", "channels"),
    target: join(dataDir, "memory", "surfaces", "discord", "channels"),
    conflictRoot: join(
      dataDir,
      "memory",
      ".migration-conflicts",
      "v1-discord-conversation-memory",
      "channels",
    ),
  });
  await migrateConversationManifests1to2(dataDir);
}

async function migrateLegacyBuiltinSkills1to2(dataDir: string): Promise<void> {
  const sourceRoot = join(dataDir, "skills", "builtin");
  if (!(await pathExists(sourceRoot))) return;

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isDiscordSurfaceSkill = DISCORD_SURFACE_BUILTIN_SKILLS.has(
      entry.name,
    );
    const targetRoot = isDiscordSurfaceSkill
      ? join(dataDir, "skills", "surfaces", "discord", "builtin")
      : join(dataDir, "skills", "core", "builtin");
    await copyTreeWithoutOverwrite({
      source: join(sourceRoot, entry.name),
      target: join(targetRoot, entry.name),
      conflictRoot: join(
        dataDir,
        "skills",
        ".migration-conflicts",
        isDiscordSurfaceSkill ? "v1-discord-surface-skills" : "v1-core-skills",
        "builtin",
        entry.name,
      ),
    });
    await replaceWithBundledBuiltinSkill({
      name: entry.name,
      targetRoot,
      surface: isDiscordSurfaceSkill ? "discord" : undefined,
    });
  }
  await rm(sourceRoot, { recursive: true, force: true });
}

async function migrateLegacyCustomSkills1to2(dataDir: string): Promise<void> {
  const sourceRoot = join(dataDir, "skills", "custom");
  if (!(await pathExists(sourceRoot))) return;

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const isDiscordSurfaceSkill = DISCORD_SURFACE_CUSTOM_SKILLS.has(entry.name);
    const targetRoot = isDiscordSurfaceSkill
      ? join(dataDir, "skills", "surfaces", "discord", "custom")
      : join(dataDir, "skills", "core", "custom");
    await copyTreeWithoutOverwrite({
      source: join(sourceRoot, entry.name),
      target: join(targetRoot, entry.name),
      conflictRoot: join(
        dataDir,
        "skills",
        ".migration-conflicts",
        isDiscordSurfaceSkill ? "v1-discord-surface-skills" : "v1-core-skills",
        "custom",
        entry.name,
      ),
    });
  }
  await rm(sourceRoot, { recursive: true, force: true });
}

async function replaceWithBundledBuiltinSkill(input: {
  name: string;
  targetRoot: string;
  surface?: string | undefined;
}): Promise<void> {
  const bundledPath = input.surface
    ? join(
        process.cwd(),
        "data",
        "skills",
        "surfaces",
        input.surface,
        "builtin",
        input.name,
        "SKILL.md",
      )
    : join(
        process.cwd(),
        "data",
        "skills",
        "core",
        "builtin",
        input.name,
        "SKILL.md",
      );
  if (!(await pathExists(bundledPath))) return;
  const targetPath = join(input.targetRoot, input.name, "SKILL.md");
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, await readFile(bundledPath, "utf8"), "utf8");
}

async function needsMigration1to2(dataDir: string): Promise<boolean> {
  const legacyPaths = [
    join(dataDir, "skills", "builtin"),
    join(dataDir, "skills", "custom"),
    join(dataDir, "memory", "threads"),
    join(dataDir, "memory", "channels"),
  ];
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) return true;
  }
  for (const manifestPath of await conversationManifestPaths(dataDir)) {
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      JSON.stringify(parsed) !==
      JSON.stringify(migrateConversationManifest1to2(parsed))
    ) {
      return true;
    }
  }
  return false;
}

async function moveLegacyTree(input: {
  source: string;
  target: string;
  conflictRoot: string;
}): Promise<void> {
  if (!(await pathExists(input.source))) return;
  await copyTreeWithoutOverwrite(input);
  await rm(input.source, { recursive: true, force: true });
}

async function migrateConversationManifests1to2(
  dataDir: string,
): Promise<void> {
  const manifestPaths = await conversationManifestPaths(dataDir);
  for (const manifestPath of manifestPaths) {
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateConversationManifest1to2(parsed);
    if (JSON.stringify(parsed) === JSON.stringify(migrated)) continue;
    await writeFile(
      manifestPath,
      `${JSON.stringify(migrated, null, 2)}\n`,
      "utf8",
    );
  }
}

function migrateConversationManifest1to2(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const surface = stringValue(value["surface"]) ?? inferLegacySurface(value);
  const platform = stringValue(value["platform"]) ?? "discord";
  const kind = stringValue(value["kind"]) ?? inferLegacyKind(value);
  const source = isRecord(value["source"]) ? value["source"] : undefined;
  const surfaceContext = {
    ...legacySurfaceContext(value),
    ...(isRecord(value["surfaceContext"]) ? value["surfaceContext"] : {}),
  };
  if (source && !("source" in surfaceContext))
    surfaceContext["source"] = source;

  const migrated: Record<string, unknown> = {};
  copyValue(value, migrated, "canonicalId");
  migrated["surface"] = surface;
  migrated["platform"] = platform;
  migrated["kind"] = kind;
  copyValue(value, migrated, "title");
  copyValue(value, migrated, "createdAt");
  copyValue(value, migrated, "updatedAt");
  migrated["starterParticipantRef"] =
    stringValue(value["starterParticipantRef"]) ??
    legacyStarterParticipantRef(value);
  migrated["participants"] = Array.isArray(value["participants"])
    ? value["participants"].map(migrateConversationParticipant1to2)
    : [];
  migrated["memoryScopes"] = migrateMemoryScopes1to2(value, kind);
  migrated["surfaceContext"] = surfaceContext;
  const surfacePrompt =
    stringValue(value["surfacePrompt"]) ??
    discordThreadSurfacePrompt(surfaceContext);
  if (surfacePrompt) migrated["surfacePrompt"] = surfacePrompt;
  return migrated;
}

function migrateConversationParticipant1to2(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (typeof value["platform"] === "string") return value;
  if (
    typeof value["discordUserId"] === "string" &&
    typeof value["username"] === "string" &&
    typeof value["joinedAt"] === "string"
  ) {
    return {
      platform: "discord",
      platformUserId: value["discordUserId"],
      username: value["username"],
      displayName: stringValue(value["displayName"]) ?? value["username"],
      joinedAt: value["joinedAt"],
    };
  }
  return value;
}

function migrateMemoryScopes1to2(
  manifest: Record<string, unknown>,
  kind: string,
): unknown[] {
  if (Array.isArray(manifest["memoryScopes"])) {
    return manifest["memoryScopes"].map((scope) => {
      if (!isRecord(scope)) return scope;
      const refPrefix = stringValue(scope["refPrefix"]);
      if (!refPrefix) return scope;
      return {
        ...scope,
        refPrefix: migrateConversationMemoryRefPrefix(refPrefix),
      };
    });
  }
  const context = isRecord(manifest["surfaceContext"])
    ? manifest["surfaceContext"]
    : manifest;
  if (kind === "thread" && typeof context["threadId"] === "string") {
    const scopes: Record<string, unknown>[] = [
      {
        label: "Current Thread Archive",
        refPrefix: `surfaces/discord/threads/${context["threadId"]}`,
        area: "current_thread",
      },
    ];
    const source = isRecord(context["source"]) ? context["source"] : undefined;
    if (
      source?.["kind"] === "channel_branch" &&
      typeof source["originChannelId"] === "string"
    ) {
      scopes.push({
        label: "Parent Channel Room",
        refPrefix: `surfaces/discord/channels/${source["originChannelId"]}`,
        area: "parent_channel",
      });
    }
    return scopes;
  }
  if (kind === "channel" && typeof context["channelId"] === "string") {
    return [
      {
        label: "Current Channel Room",
        refPrefix: `surfaces/discord/channels/${context["channelId"]}`,
        area: "current_channel",
      },
    ];
  }
  return [];
}

function migrateConversationMemoryRefPrefix(refPrefix: string): string {
  const normalized = refPrefix.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.startsWith("threads/")) {
    return `surfaces/discord/${normalized}`;
  }
  if (normalized.startsWith("channels/")) {
    return `surfaces/discord/${normalized}`;
  }
  return normalized;
}

function discordThreadSurfacePrompt(
  surfaceContext: Record<string, unknown>,
): string | undefined {
  const source = surfaceContext["source"];
  if (!isRecord(source) || source["kind"] !== "channel_branch") {
    return undefined;
  }
  const parentConversationId = stringValue(source["parentConversationId"]);
  const originMessageUrl = stringValue(source["originMessageUrl"]);
  const bridgeSummary = stringValue(source["bridgeSummary"]);
  if (!parentConversationId || !originMessageUrl || !bridgeSummary) {
    return undefined;
  }
  return [
    "This is a Sandi-managed Discord thread branched from a standard channel.",
    `Parent channel conversation ID: ${parentConversationId}`,
    `Thread origin message: ${originMessageUrl}`,
    `Branch context: ${bridgeSummary}`,
    "Parent channel context is available by pointer; do not assume unrelated parent-channel chatter is part of this scoped thread.",
  ].join("\n");
}

async function conversationManifestPaths(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "conversations");
  const paths: string[] = [];
  await collectConversationManifests(root, paths);
  return paths;
}

async function collectConversationManifests(
  dir: string,
  paths: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectConversationManifests(path, paths);
      continue;
    }
    if (entry.isFile() && entry.name === "manifest.json") paths.push(path);
  }
}

function legacySurfaceContext(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  copyString(value, context, "guildId");
  copyString(value, context, "channelId");
  copyString(value, context, "threadId");
  return context;
}

function inferLegacySurface(value: Record<string, unknown>): string {
  if (
    typeof value["guildId"] === "string" ||
    typeof value["channelId"] === "string" ||
    typeof value["threadId"] === "string"
  ) {
    return "discord";
  }
  return "unknown";
}

function inferLegacyKind(value: Record<string, unknown>): string {
  if (typeof value["threadId"] === "string") return "thread";
  return "channel";
}

function legacyStarterParticipantRef(
  value: Record<string, unknown>,
): string | undefined {
  const starterUserId = stringValue(value["starterUserId"]);
  return starterUserId ? `discord:${starterUserId}` : undefined;
}

function copyValue(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) target[key] = source[key];
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = stringValue(source[key]);
  if (value) target[key] = value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function copyTreeWithoutOverwrite(input: {
  source: string;
  target: string;
  conflictRoot: string;
}): Promise<void> {
  const sourceStats = await stat(input.source);
  if (sourceStats.isDirectory()) {
    await mkdir(input.target, { recursive: true });
    const entries = await readdir(input.source, { withFileTypes: true });
    for (const entry of entries) {
      await copyTreeWithoutOverwrite({
        source: join(input.source, entry.name),
        target: join(input.target, entry.name),
        conflictRoot: join(input.conflictRoot, entry.name),
      });
    }
    return;
  }

  if (!sourceStats.isFile()) return;
  if (await pathExists(input.target)) {
    await mkdir(dirname(input.conflictRoot), { recursive: true });
    await cp(input.source, input.conflictRoot, { force: true });
    return;
  }
  await mkdir(dirname(input.target), { recursive: true });
  await cp(input.source, input.target, { force: false });
}

function timestampForPath(): string {
  return new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "Z");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
