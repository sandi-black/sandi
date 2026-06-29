import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ConversationManifest } from "@/lib/conversations/types";
import { createLogger } from "@/lib/logging";
import {
  encodeConversation,
  freshNotesForConversation,
  runDreamForConversation,
} from "@/lib/memory/consolidation";
import {
  episodicNoteRef,
  episodicScopePrefix,
  listEpisodicNotes,
  notesTouchedSince,
  resolveMemoryPath,
  writeEpisodicNote,
} from "@/lib/memory/episodic-notes";
import {
  DREAM_SYSTEM_PROMPT,
  ENCODE_SYSTEM_PROMPT,
} from "@/lib/memory/prompts";
import {
  formatTranscript,
  parsePiSessionTranscript,
} from "@/lib/memory/transcript";
import type {
  ModelProviderClient,
  ProviderProbe,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import { piSessionFilePath } from "@/lib/provider/pi-cli-client";

// A surface-neutral fixture: this is a core (src/lib) module, so it must not
// couple to a specific surface. The github platform exercises the same code
// paths without tripping the surface-boundary check.
const SCOPE_PREFIX = "surfaces/github/threads/t1";
const NOTE_REF = `${SCOPE_PREFIX}/episodes/2026-06-29.md`;

const logger = createLogger("verify-dreaming");

// A provider stand-in that records every turn it is asked to run and replies with
// canned text keyed off the system prompt, so the consolidation passes can be
// exercised without spawning a real model.
class FakeProvider implements ModelProviderClient {
  readonly requests: ProviderTurnRequest[] = [];

  async probe(): Promise<ProviderProbe> {
    return {
      command: { ok: true, detail: "fake" },
      version: { ok: true, detail: "fake" },
      model: { ok: true, detail: "fake" },
    };
  }

  async generateTurn(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    this.requests.push(request);
    const text =
      request.instructions === ENCODE_SYSTEM_PROMPT
        ? "Garden planning chat.\nThey prefer raised beds and watering in the morning."
        : "Consolidated what mattered.";
    return { text, deliverySideEffects: false, raw: {} };
  }
}

function manifestFor(): ConversationManifest {
  return {
    canonicalId: "github:thread:t1",
    surface: "github",
    platform: "github",
    kind: "thread",
    title: "Garden planning",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    starterParticipantRef: "github:u1",
    participants: [
      {
        platform: "github",
        platformUserId: "u1",
        username: "jess",
        identityId: "jess-human",
        joinedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    memoryScopes: [
      {
        label: "Thread",
        refPrefix: SCOPE_PREFIX,
        area: "current_thread",
      },
    ],
  };
}

const SESSION_JSONL = [
  JSON.stringify({ type: "session", id: "s1", cwd: "/x" }),
  JSON.stringify({
    type: "message",
    id: "m1",
    message: { role: "user", content: "I want to plan a vegetable garden" },
  }),
  JSON.stringify({
    type: "message",
    id: "m2",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Lovely. Raised beds work well." }],
    },
  }),
  JSON.stringify({
    type: "message",
    id: "m3",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "memory_search" }],
    },
  }),
  // An unknown entry type and a malformed line must both be tolerated.
  JSON.stringify({ type: "model_change", id: "x1", modelId: "whatever" }),
  "{ not json",
  "",
].join("\n");

// 1. Transcript parsing is tolerant and keeps only human-meaningful turns.
{
  const turns = parsePiSessionTranscript(SESSION_JSONL);
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ["user", "assistant", "assistant"],
  );
  const text = formatTranscript(turns);
  assert.match(text, /Human: I want to plan a vegetable garden/);
  assert.match(text, /Sandi: Lovely\. Raised beds work well\./);
  assert.match(text, /\[uses memory_search\]/);

  const trimmed = formatTranscript(turns, { maxChars: 40 });
  assert.ok(trimmed.length <= 80);
  assert.match(trimmed, /trimmed/);
}

// 2. Episodic note refs, path safety, and round-tripping through disk.
{
  const manifest = manifestFor();
  assert.equal(episodicScopePrefix(manifest), SCOPE_PREFIX);
  assert.equal(
    episodicNoteRef(SCOPE_PREFIX, new Date("2026-06-29T10:00:00Z")),
    NOTE_REF,
  );

  assert.throws(() => resolveMemoryPath("/root", "../escape.md"));
  assert.throws(() => resolveMemoryPath("/root", "ok/notmarkdown.txt"));

  const noScope = manifestFor();
  noScope.memoryScopes = [];
  assert.equal(episodicScopePrefix(noScope), undefined);

  const tempRoot = await mkdtemp(join(tmpdir(), "sandi-notes-"));
  try {
    const memoryRoot = join(tempRoot, "memory");
    await writeEpisodicNote({
      memoryRoot,
      ref: NOTE_REF,
      summary: "A summary line",
      body: "First line summary\n\nBody detail about beds.",
    });
    const notes = await listEpisodicNotes(memoryRoot, SCOPE_PREFIX);
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.ok(note);
    assert.equal(note.summary, "A summary line");
    assert.match(note.body, /Body detail about beds\./);

    const before = new Date(note.updatedAt.getTime() - 1_000);
    const after = new Date(note.updatedAt.getTime() + 1_000);
    assert.equal(notesTouchedSince(notes, before).length, 1);
    assert.equal(notesTouchedSince(notes, after).length, 0);
    assert.equal(notesTouchedSince(notes, null).length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 3. Encoding summarizes the transcript into an episodic note on low thinking.
{
  const tempRoot = await mkdtemp(join(tmpdir(), "sandi-encode-"));
  try {
    const dataDir = join(tempRoot, "data");
    const sessionDir = join(dataDir, "pi-sessions");
    const manifest = manifestFor();
    const sessionFile = piSessionFilePath(sessionDir, manifest.canonicalId);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, SESSION_JSONL, "utf8");

    const provider = new FakeProvider();
    const result = await encodeConversation({
      provider,
      dataDir,
      sessionDir,
      manifest,
      now: new Date("2026-06-29T12:00:00Z"),
      transcriptCharBudget: 10_000,
      logger,
    });
    assert.equal(result.written, true);

    const request = provider.requests[0];
    assert.ok(request);
    assert.equal(request.thinking, "low");
    assert.equal(request.sessionMode, "none");
    assert.equal(request.instructions, ENCODE_SYSTEM_PROMPT);
    assert.match(request.input, /vegetable garden/);
    assert.equal(request.accountRouting?.identityId, "jess-human");

    const notePath = join(dataDir, "memory", NOTE_REF);
    const written = await readFile(notePath, "utf8");
    assert.match(written, /summary: Garden planning chat\./);
    assert.match(written, /raised beds/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// 4. Dreaming consolidates fresh notes on high thinking and surfaces them.
{
  const tempRoot = await mkdtemp(join(tmpdir(), "sandi-dream-"));
  try {
    const dataDir = join(tempRoot, "data");
    const sessionDir = join(dataDir, "pi-sessions");
    const memoryRoot = join(dataDir, "memory");
    const manifest = manifestFor();
    await writeEpisodicNote({
      memoryRoot,
      ref: NOTE_REF,
      summary: "Garden planning chat.",
      body: "They prefer raised beds and watering in the morning.",
    });

    const notes = await freshNotesForConversation({
      memoryRoot,
      manifest,
      since: null,
    });
    assert.equal(notes.length, 1);

    const provider = new FakeProvider();
    const result = await runDreamForConversation({
      provider,
      dataDir,
      sessionDir,
      manifest,
      notes,
      transcriptCharBudget: 10_000,
      logger,
    });
    assert.equal(result.dreamed, true);

    const request = provider.requests[0];
    assert.ok(request);
    assert.equal(request.thinking, "high");
    assert.equal(request.sessionMode, "none");
    assert.equal(request.instructions, DREAM_SYSTEM_PROMPT);
    assert.match(request.input, /Fresh notes/);
    assert.match(request.input, /raised beds/);
    assert.equal(request.accountRouting?.identityId, "jess-human");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

logger.info("dreaming verification passed");
console.log("dreaming verification passed");
