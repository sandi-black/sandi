import { access, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type {
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantMemoryRef } from "@/lib/identity/types";

export type MemoryContext = {
  memoryRoot: string;
  conversation?: ConversationManifest;
  memoryScopes: ConversationMemoryScope[];
  participants: ConversationParticipant[];
};

type MemoryScope = {
  label: string;
  dir: string;
  refPrefix: string;
};

type ScannedScope = {
  mainMemory: { ref: string; content: string } | null;
};

export function buildMemoryContext(input: {
  dataDir: string;
  conversation?: ConversationManifest;
  participants: ConversationParticipant[];
}): MemoryContext {
  const context: MemoryContext = {
    memoryRoot: join(input.dataDir, "memory"),
    memoryScopes: input.conversation?.memoryScopes ?? [],
    participants: input.participants,
  };
  if (input.conversation) context.conversation = input.conversation;
  return context;
}

export async function loadMemory(context: MemoryContext): Promise<string> {
  const scopes = memoryScopes(context);
  const scanned = await Promise.all(
    scopes.map(async (scope) => ({
      scope,
      memory: await scanScope(scope),
    })),
  );

  return formatMemoryOverview(
    context,
    scanned
      .map(({ scope, memory }) => formatScratchpad(scope.label, memory))
      .filter((section): section is string => section !== null),
  );
}

function memoryScopes(context: MemoryContext): MemoryScope[] {
  const root = context.memoryRoot;
  const scopes: MemoryScope[] = [
    {
      label: "System",
      dir: join(root, "system"),
      refPrefix: "system",
    },
    {
      label: "Self",
      dir: join(root, "self"),
      refPrefix: "self",
    },
    {
      label: "Household",
      dir: join(root, "household"),
      refPrefix: "household",
    },
  ];

  scopes.push(
    ...context.memoryScopes.map((scope) => scopeFromRef(root, scope)),
  );

  for (const participant of context.participants) {
    scopes.push({
      label: `User: ${participant.username}`,
      dir: join(root, participant.platform, participant.platformUserId),
      refPrefix: `${participant.platform}/${participant.platformUserId}`,
    });
  }

  return scopes;
}

function scopeFromRef(
  root: string,
  scope: ConversationMemoryScope,
): MemoryScope {
  const refPrefix = normalizeRefPrefix(scope.refPrefix);
  return {
    label: scope.label,
    dir: resolveMemoryRef(root, refPrefix),
    refPrefix,
  };
}

async function scanScope(scope: MemoryScope): Promise<ScannedScope> {
  const memoryPath = join(scope.dir, "MEMORY.md");
  const mainMemoryContent = await readIfExists(memoryPath);
  const mainMemory =
    mainMemoryContent === null
      ? null
      : {
          ref: `${scope.refPrefix}/MEMORY.md`,
          content: mainMemoryContent,
        };

  return { mainMemory };
}

function formatMemoryOverview(
  context: MemoryContext,
  scratchpads: string[],
): string {
  const areas = [
    "- system: machine, sandbox, tooling, paths, and runtime environment details",
    "- self: Sandi's own durable self-continuity",
    "- household: shared context for Sandi and the active group",
    "- participant platform arenas: active participant memory only",
    "- topics: recurring household topics and projects",
    "- surfaces/<surface>/threads: surface-provided thread conversation scopes",
    "- surfaces/<surface>/channels: surface-provided room or channel conversation scopes",
  ];
  const activeUsers = context.participants.map((participant) => {
    const identity = participant.identityId
      ? `, identity ${participant.identityId}`
      : "";
    return `  - ${participant.username}: ${participantMemoryRef(participant)}${identity}`;
  });
  const currentArchive = currentArchiveLine(context.conversation);

  return [
    "Available memory areas:",
    ...areas,
    "",
    "Active user memory refs:",
    ...(activeUsers.length > 0 ? activeUsers : ["  - none"]),
    currentArchive,
    "",
    "Use memory_search for prior context, memory_list to inspect an area, and memory_read for details. Prefer searching before assuming an older detail is absent.",
    "",
    scratchpads.length > 0
      ? ["Visible scratchpads:", ...scratchpads].join("\n\n")
      : "Visible scratchpads: none",
  ].join("\n");
}

function currentArchiveLine(
  conversation: ConversationManifest | undefined,
): string {
  if (!conversation) return "Current conversation memory area: none";
  if (conversation.memoryScopes.length === 0) {
    return "Current conversation memory area: none";
  }
  return conversation.memoryScopes
    .map((scope) => `${scope.label} area: ${scope.refPrefix}`)
    .join("\n");
}

function formatScratchpad(label: string, scope: ScannedScope): string | null {
  if (!scope.mainMemory) return null;
  return [
    `== ${label} ==`,
    `Scratchpad (${scope.mainMemory.ref}):`,
    scope.mainMemory.content.trimEnd(),
  ].join("\n");
}

async function readIfExists(filepath: string): Promise<string | null> {
  try {
    await access(filepath);
    return await readFile(filepath, "utf8");
  } catch {
    return null;
  }
}

function normalizeRefPrefix(refPrefix: string): string {
  const normalized = refPrefix.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Invalid memory scope ref prefix: ${refPrefix}`);
  }
  const root = parts[0];
  if (
    root === "system" ||
    root === "self" ||
    root === "household" ||
    root === "topics" ||
    root === "discord" ||
    root === "github"
  ) {
    throw new Error(
      `Conversation memory scope overlaps a core memory root: ${refPrefix}`,
    );
  }
  return parts.join("/");
}

function resolveMemoryRef(root: string, refPrefix: string): string {
  const absolute = resolve(root, refPrefix);
  const relativePath = relative(root, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid memory scope ref prefix: ${refPrefix}`);
  }
  return absolute;
}
