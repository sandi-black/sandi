import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { SessionSummary, TranscriptEntry } from "@shared/ipc-contract";

import { isMissingFileError } from "./fs-errors";
import { ConversationIdSchema, ReplyAttachmentSchema } from "./ipc-schemas";
import { z } from "zod/v4";

// The app's own conversation history. The server has no list or transcript
// endpoint (conversations are implicit and scoped to this device), so this
// store is the source of truth for the sidebar and the transcript view: one
// append-only JSONL file per conversation plus an atomically rewritten
// index.json for the session list.

const TranscriptAttachmentSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["image", "file"]),
});

const TranscriptEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    turnId: z.string(),
    ts: z.string(),
    text: z.string(),
    attachments: z.array(TranscriptAttachmentSchema).optional(),
  }),
  z.object({
    type: z.literal("assistant"),
    turnId: z.string(),
    ts: z.string(),
    text: z.string(),
    thinking: z.string().optional(),
    // The same strict shape the save-as IPC boundary parses: these paths
    // render through sandi-asset:// and come back to main for copying, so a
    // hand-edited transcript line gets the same scrutiny as a live event.
    attachments: z.array(ReplyAttachmentSchema).optional(),
  }),
  z.object({
    type: z.literal("error"),
    turnId: z.string(),
    ts: z.string(),
    text: z.string(),
  }),
]);

// The index is a disk boundary like any other: a hand-edited or corrupted
// conversationId must not flow back out as a SessionSummary and later reach
// the filename join, so it is parsed with the same strict schema the IPC
// layer uses.
const IndexSchema = z.object({
  sessions: z.array(
    z.object({
      conversationId: ConversationIdSchema,
      title: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      lastPreview: z.string(),
    }),
  ),
});

const PREVIEW_CHARS = 120;

// appendEntry fires on every user message and every settled turn; the
// sidebar's list and preview come from the in-memory `sessions` array
// (updated synchronously below), not from index.json, so a debounced write
// never shows up as stale UI. index.json only matters again on the next
// startup, and only for sort order and preview text: the conversation
// content itself lives in the per-conversation JSONL files, appended
// immediately and never debounced. A short trailing debounce, flushed on
// quit, turns the common case of several rapid appends into one write
// instead of one per entry.
const INDEX_SAVE_DEBOUNCE_MS = 400;

// The title a conversation carries until it is named: created with it, and
// auto-titling treats it as "still untitled" so it fires exactly once and never
// overwrites a real title.
export const DEFAULT_SESSION_TITLE = "New conversation";

export type TranscriptStore = {
  listSessions(): SessionSummary[];
  getSession(conversationId: string): SessionSummary | undefined;
  createSession(title?: string): Promise<SessionSummary>;
  getTranscript(conversationId: string): Promise<TranscriptEntry[]>;
  appendEntry(conversationId: string, entry: TranscriptEntry): Promise<void>;
  renameSession(conversationId: string, title: string): Promise<void>;
  deleteSession(conversationId: string): Promise<void>;
  // Writes a pending debounced index update immediately, if one is pending.
  // Call this from the app's quit path so a coalesced write is never lost to
  // a clean shutdown.
  flushIndex(): Promise<void>;
};

export async function createTranscriptStore(
  baseDir: string,
): Promise<TranscriptStore> {
  await mkdir(baseDir, { recursive: true });
  const indexPath = join(baseDir, "index.json");
  let sessions = await loadIndex(indexPath);

  // Newest activity first, which is exactly the sidebar's order. Kept
  // synchronous on every mutation below (not folded into the debounced disk
  // write) so listSessions() is never stale mid-debounce; writeIndex only
  // ever serializes an array that is already in the right order.
  const resort = (): void => {
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const writeIndex = async (): Promise<void> => {
    const temp = `${indexPath}.tmp`;
    await writeFile(temp, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
    await rename(temp, indexPath);
  };

  let indexSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const flushIndex = async (): Promise<void> => {
    if (!indexSaveTimer) return;
    clearTimeout(indexSaveTimer);
    indexSaveTimer = undefined;
    await writeIndex();
  };
  const scheduleIndexSave = (): void => {
    if (indexSaveTimer) clearTimeout(indexSaveTimer);
    indexSaveTimer = setTimeout(() => {
      indexSaveTimer = undefined;
      writeIndex().catch((error: unknown) => {
        console.error("failed to persist the transcript index", error);
      });
    }, INDEX_SAVE_DEBOUNCE_MS);
  };
  // createSession/renameSession/deleteSession are infrequent, directly
  // user-triggered edits to the index (not the per-message hot path), so they
  // keep writing through immediately; that also supersedes any debounced
  // write an append just scheduled, since the sessions array it would have
  // written is now stale anyway.
  const persistIndexNow = async (): Promise<void> => {
    if (indexSaveTimer) {
      clearTimeout(indexSaveTimer);
      indexSaveTimer = undefined;
    }
    await writeIndex();
  };

  const transcriptPath = (conversationId: string): string =>
    join(baseDir, `${conversationId}.jsonl`);

  return {
    listSessions() {
      return sessions.map((session) => ({ ...session }));
    },

    getSession(conversationId) {
      const session = sessions.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      return session ? { ...session } : undefined;
    },

    async createSession(title) {
      const now = new Date().toISOString();
      const session: SessionSummary = {
        // The same shape the reference CLI mints; the server treats it as an
        // opaque per-device conversation segment.
        conversationId: `desktop-${randomUUID()}`,
        title: title ?? DEFAULT_SESSION_TITLE,
        createdAt: now,
        updatedAt: now,
        lastPreview: "",
      };
      sessions.push(session);
      resort();
      await persistIndexNow();
      return { ...session };
    },

    async getTranscript(conversationId) {
      let raw: string;
      try {
        raw = await readFile(transcriptPath(conversationId), "utf8");
      } catch (error) {
        // A session with no turns yet has no file; that is an empty
        // transcript. Anything else (permissions, I/O) is a real failure.
        if (isMissingFileError(error)) return [];
        throw error;
      }
      const entries: TranscriptEntry[] = [];
      let skipped = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          // Unparseable JSON (a torn write or a manual edit) is skipped rather
          // than poisoning the whole transcript, but the loss is counted and
          // surfaced below rather than swallowed silently.
          skipped++;
          continue;
        }
        const parsed = TranscriptEntrySchema.safeParse(value);
        if (parsed.success) {
          entries.push(normalizeEntry(parsed.data));
        } else {
          skipped++;
        }
      }
      if (skipped > 0) {
        console.error(
          `transcript ${conversationId}: skipped ${skipped} unreadable line(s), kept the ${entries.length} that parsed`,
        );
      }
      return entries;
    },

    async appendEntry(conversationId, entry) {
      await appendFile(
        transcriptPath(conversationId),
        `${JSON.stringify(entry)}\n`,
        "utf8",
      );
      const session = sessions.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (session) {
        session.updatedAt = entry.ts;
        if (entry.type !== "error") {
          session.lastPreview = entry.text.slice(0, PREVIEW_CHARS);
        }
        resort();
        scheduleIndexSave();
      }
    },

    async renameSession(conversationId, title) {
      const session = sessions.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (!session) return;
      session.title = title;
      session.updatedAt = new Date().toISOString();
      resort();
      await persistIndexNow();
    },

    async deleteSession(conversationId) {
      sessions = sessions.filter(
        (candidate) => candidate.conversationId !== conversationId,
      );
      await persistIndexNow();
      await rm(transcriptPath(conversationId), { force: true });
    },

    flushIndex,
  };
}

// zod infers `.optional()` fields as `| undefined`, which
// exactOptionalPropertyTypes keeps apart from the contract's plain optional
// properties; rebuilding without the undefined-valued keys reconciles the two.
function normalizeEntry(
  entry: z.infer<typeof TranscriptEntrySchema>,
): TranscriptEntry {
  if (entry.type === "user") {
    const { attachments, ...rest } = entry;
    return { ...rest, ...(attachments !== undefined ? { attachments } : {}) };
  }
  if (entry.type === "assistant") {
    const { attachments, thinking, ...rest } = entry;
    return {
      ...rest,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(attachments !== undefined
        ? {
            attachments: attachments.map(({ path, name, mimeType }) => ({
              path,
              ...(name !== undefined ? { name } : {}),
              ...(mimeType !== undefined ? { mimeType } : {}),
            })),
          }
        : {}),
    };
  }
  return entry;
}

async function loadIndex(indexPath: string): Promise<SessionSummary[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    // No index yet is a first run; a permission or I/O error is not, and must
    // not be mistaken for an empty session list.
    if (isMissingFileError(error)) return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return quarantineIndex(indexPath);
  }
  const parsed = IndexSchema.safeParse(data);
  if (parsed.success) return parsed.data.sessions;
  return quarantineIndex(indexPath);
}

// An index that exists but does not parse is corrupt state, not an empty
// session list. Move the original aside so the next index persist cannot
// overwrite the only copy, and surface the reset; the JSONL transcripts
// themselves are untouched, so the sessions' content survives even though
// the sidebar starts empty.
async function quarantineIndex(indexPath: string): Promise<SessionSummary[]> {
  const backupPath = `${indexPath}.corrupt`;
  await rename(indexPath, backupPath);
  console.error(
    `transcript index was corrupt; moved it to ${backupPath} and starting empty`,
  );
  return [];
}
