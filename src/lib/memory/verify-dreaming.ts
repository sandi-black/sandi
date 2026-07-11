import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConversationManifest } from "@/lib/conversations/types";
import { createLogger } from "@/lib/logging";
import {
  conversationHasUnencodedActivity,
  encodeConversation,
  freshNotesForConversation,
  runDreamForConversation,
} from "@/lib/memory/consolidation";
import { DreamStateStore } from "@/lib/memory/dream-state";
import { loadDreamingConfig } from "@/lib/memory/dreaming-config";
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
import { withTempDir } from "@/lib/verification/harness";

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

// 1. Transcript parsing keeps human-meaningful turns, skips expected non-message
// records, and counts only genuinely unreadable data.
{
  const parsed = parsePiSessionTranscript(SESSION_JSONL);
  assert.deepEqual(
    parsed.turns.map((turn) => turn.role),
    ["user", "assistant", "assistant"],
  );
  // The "{ not json" line is unreadable; the model_change record is an expected
  // non-message entry and is not counted as corruption.
  assert.equal(parsed.unparseableLines, 1);
  assert.equal(parsed.malformedMessages, 0);

  const text = formatTranscript(parsed.turns);
  assert.match(text, /Human: I want to plan a vegetable garden/);
  assert.match(text, /Sandi: Lovely\. Raised beds work well\./);
  assert.match(text, /\[uses memory_search\]/);

  const trimmed = formatTranscript(parsed.turns, { maxChars: 40 });
  assert.ok(trimmed.length <= 80);
  assert.match(trimmed, /trimmed/);

  // A record claiming to be a message but failing validation is counted.
  const malformed = parsePiSessionTranscript(
    JSON.stringify({ type: "message", message: { bogus: true } }),
  );
  assert.equal(malformed.malformedMessages, 1);

  // A structurally valid message whose content block announces a known type but
  // fails it (a text block with a non-string text) is counted, not dropped.
  const malformedBlock = parsePiSessionTranscript(
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: 123 }] },
    }),
  );
  assert.equal(malformedBlock.malformedMessages, 1);

  // A known text-free block (thinking) is not flagged as malformed.
  const thinkingOnly = parsePiSessionTranscript(
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking" }] },
    }),
  );
  assert.equal(thinkingOnly.malformedMessages, 0);
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

  await withTempDir("sandi-notes-", async (tempRoot) => {
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
  });
}

// 3. Encoding summarizes the transcript into an episodic note on low thinking.
await withTempDir("sandi-encode-", async (tempRoot) => {
  const dataDir = join(tempRoot, "data");
  const sessionDir = join(dataDir, "pi-sessions");
  const manifest = manifestFor();
  const sessionFile = piSessionFilePath(sessionDir, manifest.canonicalId);
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, SESSION_JSONL, "utf8");

  const provider = new FakeProvider();
  const controller = new AbortController();
  const result = await encodeConversation({
    provider,
    dataDir,
    sessionDir,
    manifest,
    now: new Date("2026-06-29T12:00:00Z"),
    transcriptCharBudget: 10_000,
    logger,
    signal: controller.signal,
  });
  assert.equal(result.written, true);

  const request = provider.requests[0];
  assert.ok(request);
  assert.equal(request.thinking, "low");
  assert.equal(request.sessionMode, "none");
  assert.equal(request.instructions, ENCODE_SYSTEM_PROMPT);
  assert.match(request.input, /vegetable garden/);
  assert.equal(request.accountRouting?.identityId, "jess-human");
  // The abort signal is threaded through so a shutdown can cancel the turn.
  assert.equal(request.signal, controller.signal);
  // Background turns keep Sandi's full toolset: nothing is disabled or
  // excluded; the context only wires the runtime.
  assert.equal(request.surfaceContext?.name, "dreaming");
  assert.notEqual(request.surfaceContext?.disableBuiltinTools, true);
  assert.equal(request.surfaceContext?.excludeTools, undefined);

  const notePath = join(dataDir, "memory", NOTE_REF);
  const written = await readFile(notePath, "utf8");
  assert.match(written, /summary: Garden planning chat\./);
  assert.match(written, /raised beds/);
});

// 4. Dreaming consolidates fresh notes on high thinking and surfaces them.
await withTempDir("sandi-dream-", async (tempRoot) => {
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
  // Dreaming runs with Sandi's full toolset; nothing is disabled or excluded.
  assert.equal(request.surfaceContext?.name, "dreaming");
  assert.notEqual(request.surfaceContext?.disableBuiltinTools, true);
  assert.equal(request.surfaceContext?.excludeTools, undefined);
});

// 5. The dream watermark is tracked and advanced per conversation.
await withTempDir("sandi-state-", async (tempRoot) => {
  const store = new DreamStateStore(join(tempRoot, "data"));
  assert.equal(await store.lastDreamAt("c1"), null);

  const when = new Date("2026-06-29T04:00:00.000Z");
  await store.markDreamed("c1", when);
  const got = await store.lastDreamAt("c1");
  assert.ok(got);
  assert.equal(got.toISOString(), when.toISOString());
  // A second conversation is independent: marking one never advances another.
  assert.equal(await store.lastDreamAt("c2"), null);

  // A loosely parseable but non-ISO timestamp is rejected at the file
  // boundary rather than coerced into a Date later.
  const statePath = join(tempRoot, "data", "dreaming", "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ version: 1, conversations: { c3: "June 29, 2026" } }),
    "utf8",
  );
  await assert.rejects(() => store.lastDreamAt("c3"));
});

// 6. Dreaming config strictly validates its env boundary.
{
  const keys = [
    "SANDI_DREAMING_IDLE_MINUTES",
    "SANDI_DREAMING_NIGHTLY_CRON",
    "SANDI_DREAMING_TIMEZONE",
    "SANDI_DREAMING_TRANSCRIPT_CHARS",
    "SANDI_DREAMING_ENABLED",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    process.env["SANDI_DREAMING_NIGHTLY_CRON"] = "0 3 * * *";
    process.env["SANDI_DREAMING_TIMEZONE"] = "UTC";

    process.env["SANDI_DREAMING_IDLE_MINUTES"] = "10abc";
    assert.throws(() => loadDreamingConfig());

    // Out-of-range and unsafe-magnitude integers are rejected, not coerced into
    // an overflowing setTimeout delay or an Infinity budget.
    process.env["SANDI_DREAMING_IDLE_MINUTES"] = "100000";
    assert.throws(() => loadDreamingConfig());
    process.env["SANDI_DREAMING_IDLE_MINUTES"] = "15";
    process.env["SANDI_DREAMING_TRANSCRIPT_CHARS"] = "9".repeat(400);
    assert.throws(() => loadDreamingConfig());

    process.env["SANDI_DREAMING_TRANSCRIPT_CHARS"] = "1000";
    const config = loadDreamingConfig();
    assert.equal(config.idleMs, 15 * 60 * 1_000);
    assert.equal(config.nightlyCron, "0 3 * * *");
    assert.equal(config.transcriptCharBudget, 1_000);

    process.env["SANDI_DREAMING_NIGHTLY_CRON"] = "not a cron";
    assert.throws(() => loadDreamingConfig());
    process.env["SANDI_DREAMING_NIGHTLY_CRON"] = "0 3 * * *";

    process.env["SANDI_DREAMING_TIMEZONE"] = "Not/AZone";
    assert.throws(() => loadDreamingConfig());
  } finally {
    restore();
  }
}

// 7. A non-missing transcript read error is surfaced, not treated as empty.
await withTempDir("sandi-readerr-", async (tempRoot) => {
  const dataDir = join(tempRoot, "data");
  const sessionDir = join(dataDir, "pi-sessions");
  const manifest = manifestFor();
  // Make the session path a directory so reading it fails with EISDIR rather
  // than the benign ENOENT.
  await mkdir(piSessionFilePath(sessionDir, manifest.canonicalId), {
    recursive: true,
  });

  const provider = new FakeProvider();
  await assert.rejects(() =>
    encodeConversation({
      provider,
      dataDir,
      sessionDir,
      manifest,
      now: new Date("2026-06-29T12:00:00Z"),
      transcriptCharBudget: 10_000,
      logger,
    }),
  );
  assert.equal(provider.requests.length, 0);
});

// 8. conversationHasUnencodedActivity drives the startup/restart-window encode.
await withTempDir("sandi-pending-", async (tempRoot) => {
  const memoryRoot = join(tempRoot, "memory");

  // No recap yet: pending (covers the first run with dreaming enabled).
  const manifest = manifestFor();
  manifest.updatedAt = "2020-01-01T00:00:00.000Z";
  assert.equal(
    await conversationHasUnencodedActivity({ memoryRoot, manifest }),
    true,
  );

  // A recap written now is newer than that manifest update: not pending.
  await writeEpisodicNote({
    memoryRoot,
    ref: NOTE_REF,
    summary: "Recap",
    body: "Recap body.",
  });
  assert.equal(
    await conversationHasUnencodedActivity({ memoryRoot, manifest }),
    false,
  );

  // A manifest updated after the newest recap is pending again.
  const active = manifestFor();
  active.updatedAt = "2999-01-01T00:00:00.000Z";
  assert.equal(
    await conversationHasUnencodedActivity({ memoryRoot, manifest: active }),
    true,
  );

  // A conversation with no scope cannot host a recap, so it is never pending.
  const noScope = manifestFor();
  noScope.memoryScopes = [];
  assert.equal(
    await conversationHasUnencodedActivity({ memoryRoot, manifest: noScope }),
    false,
  );
});

logger.info("dreaming verification passed");
console.log("dreaming verification passed");
