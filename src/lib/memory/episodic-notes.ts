import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ConversationManifest } from "@/lib/conversations/types";
import { parseFrontmatter } from "@/lib/pi-extension/memory-common";
import { withManagedWrite } from "@/lib/state/managed-write";
import {
  chmodPrivateFile,
  writePrivateTextFile,
} from "@/lib/state/private-files";

// An episodic recap note as it lives on disk under the memory root. These are
// short-term memory: Sandi's quick "what happened" snapshots that the overnight
// dream consolidates into durable memory. They are never auto-deleted.
export type EpisodicNote = {
  ref: string;
  path: string;
  summary: string | null;
  body: string;
  updatedAt: Date;
};

/**
 * Picks the conversation memory scope an episodic note belongs under. A
 * conversation usually carries a thread-level scope plus broader ones; the
 * narrowest (thread-like) scope is the right home for a per-conversation recap.
 * Returns undefined when a conversation has no scope of its own, in which case
 * it cannot host an episodic note.
 */
export function episodicScopePrefix(
  manifest: ConversationManifest,
): string | undefined {
  if (manifest.memoryScopes.length === 0) return undefined;
  const threadLike = manifest.memoryScopes.find((scope) =>
    (scope.area ?? "").includes("thread"),
  );
  const chosen = threadLike ?? manifest.memoryScopes[0];
  return chosen?.refPrefix;
}

// One recap per conversation per day. Each encode re-summarizes the whole
// conversation, so a second encode on the same day replaces the day's note with
// a fresh superset rather than losing earlier content, while distinct days are
// preserved as their own notes.
export function episodicNoteRef(prefix: string, date: Date): string {
  return `${prefix}/episodes/${isoDate(date)}.md`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Maps a logical memory ref to an absolute path under the memory root, refusing
 * any ref that would escape the root. This mirrors the traversal guard the
 * memory tools apply, so notes written directly to disk land exactly where the
 * tools would resolve the same ref.
 */
export function resolveMemoryPath(memoryRoot: string, ref: string): string {
  const normalized = ref.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized.endsWith(".md")) {
    throw new Error(`Memory ref must be a .md file: ${ref}`);
  }
  const absolute = resolve(memoryRoot, normalized);
  const rel = relative(memoryRoot, absolute);
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error(`Invalid memory ref: ${ref}`);
  }
  return absolute;
}

export function formatEpisodicNote(summary: string, body: string): string {
  return `---\nsummary: ${cleanSummary(summary)}\n---\n\n${body.trim()}\n`;
}

function cleanSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

export async function writeEpisodicNote(input: {
  memoryRoot: string;
  ref: string;
  summary: string;
  body: string;
}): Promise<void> {
  const path = resolveMemoryPath(input.memoryRoot, input.ref);
  const content = formatEpisodicNote(input.summary, input.body);
  // Written through the same private, atomic, lock-protected path as memory and
  // state files: a temp file with owner-only permissions is renamed into place,
  // so a dream never reads a half-written recap and notes are never left
  // world-readable.
  await withManagedWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    await writePrivateTextFile(tempPath, content);
    await rename(tempPath, path);
    await chmodPrivateFile(path);
  });
}

/**
 * Lists every episodic note stored under a conversation scope, oldest first,
 * tagged with the filesystem mtime used to tell which notes are new since the
 * last dream.
 */
export async function listEpisodicNotes(
  memoryRoot: string,
  prefix: string,
): Promise<EpisodicNote[]> {
  const dir = resolve(memoryRoot, `${prefix}/episodes`);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A conversation with no episodes directory simply has no notes yet; any
    // other read failure is surfaced rather than masked as "no fresh notes".
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const notes: EpisodicNote[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const { summary, body } = parseFrontmatter(raw);
    notes.push({
      ref: `${prefix}/episodes/${entry.name}`,
      path,
      summary,
      body,
      updatedAt: info.mtime,
    });
  }
  notes.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  return notes;
}

export function notesTouchedSince(
  notes: EpisodicNote[],
  since: Date | null,
): EpisodicNote[] {
  if (!since) return notes;
  return notes.filter((note) => note.updatedAt.getTime() > since.getTime());
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
