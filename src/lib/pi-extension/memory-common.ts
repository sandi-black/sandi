import { readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { z } from "zod/v4";

export type MemoryContext = {
  memoryScopes: {
    label: string;
    refPrefix: string;
    area?: string;
  }[];
  participants: {
    platform: "discord" | "github";
    platformUserId: string;
    ref: string;
    username: string;
    identityId?: string;
  }[];
};

type MemoryParticipant = MemoryContext["participants"][number];

const MemoryContextSchema = z.object({
  memoryScopes: z
    .array(
      z
        .object({
          label: z.string(),
          refPrefix: z.string(),
          area: z.string().optional(),
        })
        .transform(normalizeMemoryScope),
    )
    .optional(),
  participants: z.array(
    z
      .object({
        platform: z.enum(["discord", "github"]),
        platformUserId: z.string(),
        ref: z.string(),
        username: z.string(),
        identityId: z.string().optional(),
      })
      .transform(normalizeMemoryParticipant),
  ),
});

export function readMemoryRoot(): string {
  const value = process.env["SANDI_MEMORY_ROOT"];
  if (!value) throw new Error("SANDI_MEMORY_ROOT is not set");
  return resolve(value);
}

export function readMemoryContext(): MemoryContext {
  const raw = process.env["SANDI_MEMORY_CONTEXT"];
  if (!raw) {
    return {
      memoryScopes: [],
      participants: [],
    };
  }
  const parsed = MemoryContextSchema.parse(JSON.parse(raw));
  const context: MemoryContext = {
    memoryScopes: parsed.memoryScopes ?? [],
    participants: parsed.participants,
  };
  return context;
}

function normalizeMemoryScope(input: {
  label: string;
  refPrefix: string;
  area?: string | undefined;
}): MemoryContext["memoryScopes"][number] {
  const scope: MemoryContext["memoryScopes"][number] = {
    label: input.label,
    refPrefix: normalizeRefPrefix(input.refPrefix),
  };
  if (input.area !== undefined) scope.area = input.area;
  return scope;
}

function normalizeMemoryParticipant(input: {
  platform: MemoryParticipant["platform"];
  platformUserId: string;
  ref: string;
  username: string;
  identityId?: string | undefined;
}): MemoryParticipant {
  const participant: MemoryParticipant = {
    platform: input.platform,
    platformUserId: input.platformUserId,
    ref: input.ref,
    username: input.username,
  };
  if (input.identityId !== undefined) participant.identityId = input.identityId;
  return participant;
}

export function listAllowedRefs(
  root: string,
  context: MemoryContext,
  area?: string,
): Promise<string[]> {
  return listAllowedRefsForPrefixes(
    root,
    context,
    listPrefixesForArea(context, area),
  );
}

export function resolveAllowedRef(
  root: string,
  context: MemoryContext,
  ref: string,
): string {
  const normalized = normalizeRef(ref);
  const prefixes = allowedPrefixes(context);
  if (
    !prefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    )
  ) {
    throw new Error(
      `Memory ref is outside the current conversation's allowed scopes: ${ref}`,
    );
  }

  const absolute = resolve(root, normalized);
  const relativePath = relative(root, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid memory ref: ${ref}`);
  }
  return absolute;
}

export function parseFrontmatter(content: string): {
  summary: string | null;
  body: string;
} {
  if (!content.startsWith("---")) return { summary: null, body: content };
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return { summary: null, body: content };
  const frontmatter = content.slice(3, endIndex).trim();
  const body = content.slice(endIndex + 3).trim();
  let summary: string | null = null;
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    if (line.slice(0, colonIndex).trim() === "summary") {
      summary = line.slice(colonIndex + 1).trim();
    }
  }
  return { summary, body };
}

export function parseMemorySummary(content: string): string | null {
  return parseFrontmatter(content).summary;
}

function allowedPrefixes(context: MemoryContext): string[] {
  const prefixes = [
    "system",
    "self",
    "household",
    "topics",
    ...context.memoryScopes.map((scope) => scope.refPrefix),
  ];
  for (const participant of context.participants) {
    prefixes.push(`${participant.platform}/${participant.platformUserId}`);
  }
  return prefixes;
}

function listPrefixesForArea(
  context: MemoryContext,
  area: string | undefined,
): string[] {
  const prefixes = allowedPrefixes(context);
  if (!area) return prefixes;

  const normalized = area.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized === "users" || normalized === "participants") {
    return context.participants.map(
      (participant) => `${participant.platform}/${participant.platformUserId}`,
    );
  }
  if (normalized === "current_thread") {
    return scopePrefixesForArea(context, normalized);
  }
  if (normalized === "current_channel") {
    return scopePrefixesForArea(context, normalized);
  }
  if (normalized === "current_conversation") {
    return context.memoryScopes.map((scope) => scope.refPrefix);
  }
  const scopedAreaPrefixes = scopePrefixesForArea(context, normalized);
  if (scopedAreaPrefixes.length > 0) return scopedAreaPrefixes;
  const narrowed = new Set<string>();
  for (const prefix of prefixes) {
    if (prefix === normalized || prefix.startsWith(`${normalized}/`)) {
      narrowed.add(prefix);
    } else if (normalized.startsWith(`${prefix}/`)) {
      narrowed.add(normalized);
    }
  }
  return [...narrowed];
}

function scopePrefixesForArea(context: MemoryContext, area: string): string[] {
  return context.memoryScopes
    .filter((scope) => scope.area === area)
    .map((scope) => scope.refPrefix);
}

async function listAllowedRefsForPrefixes(
  root: string,
  context: MemoryContext,
  prefixes: string[],
): Promise<string[]> {
  const refs: string[] = [];
  for (const prefix of prefixes) {
    refs.push(
      ...(await listMarkdownRefs(
        resolveAllowedRef(root, context, `${prefix}/MEMORY.md`),
        prefix,
      )),
    );
  }
  refs.sort((a, b) => a.localeCompare(b));
  return refs;
}

function normalizeRef(ref: string): string {
  const normalized = ref.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Invalid memory ref: ${ref}`);
  }
  const filename = parts.at(-1);
  if (!filename?.endsWith(".md")) {
    throw new Error("Memory refs must point to Markdown files.");
  }
  return parts.join("/");
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

async function listMarkdownRefs(
  scopeMemoryPath: string,
  prefix: string,
): Promise<string[]> {
  const scopeDir = dirname(scopeMemoryPath);
  const refs: string[] = [];
  await collectMarkdownRefs(scopeDir, prefix, refs);
  return refs;
}

async function collectMarkdownRefs(
  dir: string,
  refPrefix: string,
  refs: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectMarkdownRefs(
        resolve(dir, entry.name),
        `${refPrefix}/${entry.name}`,
        refs,
      );
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      refs.push(`${refPrefix}/${entry.name}`);
    }
  }
}
