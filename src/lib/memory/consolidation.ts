import { readFile } from "node:fs/promises";

import { buildMemoryContext, type MemoryContext } from "@/lib/context/memory";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";
import type { Logger } from "@/lib/logging";
import { DREAMING_SURFACE_CONTEXT } from "@/lib/memory/dreaming-context";
import {
  type EpisodicNote,
  episodicNoteRef,
  episodicScopePrefix,
  listEpisodicNotes,
  notesTouchedSince,
  writeEpisodicNote,
} from "@/lib/memory/episodic-notes";
import {
  buildDreamInput,
  DREAM_SYSTEM_PROMPT,
  ENCODE_SYSTEM_PROMPT,
} from "@/lib/memory/prompts";
import {
  formatTranscript,
  parsePiSessionTranscript,
} from "@/lib/memory/transcript";
import type { PiAccountRoutingRequest } from "@/lib/provider/pi-account-routing";
import {
  type ModelProviderClient,
  piSessionFilePath,
} from "@/lib/provider/pi-cli-client";

type ConsolidationBase = {
  provider: ModelProviderClient;
  dataDir: string;
  sessionDir: string;
  manifest: ConversationManifest;
  transcriptCharBudget: number;
  logger: Logger;
};

/**
 * The idle "encode" pass. Summarizes a conversation transcript into a short
 * episodic note with the main model on low thinking (just a summarizer). Skips
 * conversations with no memory scope of their own or no transcript yet.
 */
export async function encodeConversation(
  input: ConsolidationBase & { now: Date },
): Promise<{ written: boolean }> {
  const prefix = episodicScopePrefix(input.manifest);
  if (!prefix) {
    input.logger.info("encode skipped: conversation has no memory scope", {
      conversationId: input.manifest.canonicalId,
    });
    return { written: false };
  }
  const transcript = await readTranscript(input);
  if (!transcript) return { written: false };

  const memoryContext = memoryContextFor(input.dataDir, input.manifest);
  const response = await input.provider.generateTurn({
    conversationId: `dream-encode:${input.manifest.canonicalId}`,
    instructions: ENCODE_SYSTEM_PROMPT,
    input: transcript,
    sessionMode: "none",
    thinking: "low",
    memoryContext,
    surfaceContext: DREAMING_SURFACE_CONTEXT,
    accountRouting: routingFor(input.manifest),
  });

  const recap = response.text.trim();
  if (!recap) return { written: false };

  const ref = episodicNoteRef(prefix, input.now);
  await writeEpisodicNote({
    memoryRoot: memoryContext.memoryRoot,
    ref,
    summary: recapSummary(recap),
    body: recap,
  });
  input.logger.info("encoded conversation recap", {
    conversationId: input.manifest.canonicalId,
    ref,
  });
  return { written: true };
}

/**
 * Returns the episodic notes for one conversation that were written or updated
 * since the last dream (the raw material a dream consolidates).
 */
export async function freshNotesForConversation(input: {
  memoryRoot: string;
  manifest: ConversationManifest;
  since: Date | null;
}): Promise<EpisodicNote[]> {
  const prefix = episodicScopePrefix(input.manifest);
  if (!prefix) return [];
  const notes = await listEpisodicNotes(input.memoryRoot, prefix);
  return notesTouchedSince(notes, input.since);
}

/**
 * The overnight "dream" pass for a single conversation. Sandi reviews the fresh
 * notes with the main model on high thinking and consolidates them into durable
 * memory using her own memory tools, scoped to this conversation's allowed
 * scopes so one person's private context never leaks into another's.
 */
export async function runDreamForConversation(
  input: ConsolidationBase & { notes: EpisodicNote[] },
): Promise<{ dreamed: boolean }> {
  if (input.notes.length === 0) return { dreamed: false };

  const transcript = await readTranscript(input);
  const memoryContext = memoryContextFor(input.dataDir, input.manifest);
  const dreamInput = buildDreamInput({
    conversationTitle: input.manifest.title,
    notes: input.notes.map((note) => ({
      ref: note.ref,
      summary: note.summary,
      body: note.body,
    })),
    transcript,
  });

  await input.provider.generateTurn({
    conversationId: `dream:${input.manifest.canonicalId}`,
    instructions: DREAM_SYSTEM_PROMPT,
    input: dreamInput,
    sessionMode: "none",
    thinking: "high",
    memoryContext,
    surfaceContext: DREAMING_SURFACE_CONTEXT,
    accountRouting: routingFor(input.manifest),
  });
  input.logger.info("dreamed over conversation", {
    conversationId: input.manifest.canonicalId,
    notes: input.notes.length,
  });
  return { dreamed: true };
}

async function readTranscript(input: {
  sessionDir: string;
  manifest: ConversationManifest;
  transcriptCharBudget: number;
  logger: Logger;
}): Promise<string> {
  const path = piSessionFilePath(input.sessionDir, input.manifest.canonicalId);
  let jsonl: string;
  try {
    jsonl = await readFile(path, "utf8");
  } catch (error) {
    // A missing session file just means the conversation has no transcript yet;
    // any other read failure (permissions, corruption) is surfaced rather than
    // silently treated as an empty transcript.
    if (isMissingFileError(error)) return "";
    throw error;
  }
  const parsed = parsePiSessionTranscript(jsonl);
  if (parsed.unparseableLines > 0 || parsed.malformedMessages > 0) {
    // Unreadable records mean the session file is partially corrupt. Consolidate
    // from what was readable rather than aborting, but surface it so corruption
    // is visible instead of silently summarized as if complete.
    input.logger.warn("pi session transcript had unreadable records", {
      conversationId: input.manifest.canonicalId,
      unparseableLines: parsed.unparseableLines,
      malformedMessages: parsed.malformedMessages,
    });
  }
  return formatTranscript(parsed.turns, {
    maxChars: input.transcriptCharBudget,
  });
}

function memoryContextFor(
  dataDir: string,
  manifest: ConversationManifest,
): MemoryContext {
  return buildMemoryContext({
    dataDir,
    conversation: manifest,
    participants: manifest.participants,
  });
}

// Bills a consolidation turn to the human whose conversation it is: the starter
// when they carry an identity, otherwise the first participant who does. With no
// account routing configured this request is ignored.
function routingFor(manifest: ConversationManifest): PiAccountRoutingRequest {
  const participant = routingParticipant(manifest);
  const request: PiAccountRoutingRequest = {};
  if (participant?.identityId) request.identityId = participant.identityId;
  return request;
}

function routingParticipant(
  manifest: ConversationManifest,
): ConversationParticipant | undefined {
  const starter = manifest.participants.find(
    (participant) =>
      participantRef(participant) === manifest.starterParticipantRef,
  );
  if (starter?.identityId) return starter;
  const withIdentity = manifest.participants.find(
    (participant) => participant.identityId,
  );
  return withIdentity ?? starter ?? manifest.participants[0];
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function recapSummary(recap: string): string {
  const firstLine = recap
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "Conversation recap")
    .replace(/^#+\s*/, "")
    .replace(/^summary:\s*/i, "");
}
