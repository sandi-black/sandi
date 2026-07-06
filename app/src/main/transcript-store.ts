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

export type TranscriptStore = {
  listSessions(): SessionSummary[];
  createSession(title?: string): Promise<SessionSummary>;
  getTranscript(conversationId: string): Promise<TranscriptEntry[]>;
  appendEntry(conversationId: string, entry: TranscriptEntry): Promise<void>;
  renameSession(conversationId: string, title: string): Promise<void>;
  deleteSession(conversationId: string): Promise<void>;
};

export async function createTranscriptStore(
  baseDir: string,
): Promise<TranscriptStore> {
  await mkdir(baseDir, { recursive: true });
  const indexPath = join(baseDir, "index.json");
  let sessions = await loadIndex(indexPath);

  const persistIndex = async (): Promise<void> => {
    // Newest activity first, which is exactly the sidebar's order.
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const temp = `${indexPath}.tmp`;
    await writeFile(temp, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
    await rename(temp, indexPath);
  };

  const transcriptPath = (conversationId: string): string =>
    join(baseDir, `${conversationId}.jsonl`);

  return {
    listSessions() {
      return sessions.map((session) => ({ ...session }));
    },

    async createSession(title) {
      const now = new Date().toISOString();
      const session: SessionSummary = {
        // The same shape the reference CLI mints; the server treats it as an
        // opaque per-device conversation segment.
        conversationId: `desktop-${randomUUID()}`,
        title: title ?? "New conversation",
        createdAt: now,
        updatedAt: now,
        lastPreview: "",
      };
      sessions.push(session);
      await persistIndex();
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
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = TranscriptEntrySchema.safeParse(JSON.parse(line));
          // A malformed line (torn write, manual edit) is skipped rather than
          // poisoning the whole transcript.
          if (parsed.success) entries.push(normalizeEntry(parsed.data));
        } catch {
          // Unparseable JSON: skip the line, same policy as a schema miss.
        }
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
        await persistIndex();
      }
    },

    async renameSession(conversationId, title) {
      const session = sessions.find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (!session) return;
      session.title = title;
      session.updatedAt = new Date().toISOString();
      await persistIndex();
    },

    async deleteSession(conversationId) {
      sessions = sessions.filter(
        (candidate) => candidate.conversationId !== conversationId,
      );
      await persistIndex();
      await rm(transcriptPath(conversationId), { force: true });
    },
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
  try {
    const parsed = IndexSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.sessions;
  } catch {
    // Corrupt JSON: deliberately fall through to rebuilding an empty index;
    // the JSONL transcripts on disk are untouched.
  }
  return [];
}
