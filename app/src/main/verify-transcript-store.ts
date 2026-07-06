import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTranscriptStore } from "./transcript-store";

// Round-trips the JSONL transcript and index behavior: append/read ordering,
// preview and recency maintenance, corrupt-line tolerance, rename and delete.
// Run with: npm run verify:transcript-store -w app

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sandi-transcripts-"));
  try {
    const store = await createTranscriptStore(dir);
    assert.deepEqual(store.listSessions(), [], "starts empty");

    const grace = await store.createSession("Grace's session");
    const ada = await store.createSession();
    assert.equal(ada.title, "New conversation", "default title");
    assert.equal(store.listSessions().length, 2);

    await store.appendEntry(grace.conversationId, {
      type: "user",
      turnId: "t1",
      ts: "2999-07-05T10:00:00.000Z",
      text: "Hello Sandi, Grace here.",
    });
    await store.appendEntry(grace.conversationId, {
      type: "assistant",
      turnId: "t1",
      ts: "2999-07-05T10:00:05.000Z",
      text: "Hi Grace! What are we building today?",
      thinking: "greeting back",
    });
    const transcript = await store.getTranscript(grace.conversationId);
    assert.equal(transcript.length, 2, "both entries round-trip");
    assert.equal(transcript[0]?.type, "user");
    assert.equal(transcript[1]?.type, "assistant");

    // The index tracks recency and previews; Grace's session has the newer
    // activity so it sorts first.
    const sessions = store.listSessions();
    assert.equal(sessions[0]?.conversationId, grace.conversationId);
    assert.equal(
      sessions[0]?.lastPreview,
      "Hi Grace! What are we building today?",
    );
    assert.equal(sessions[0]?.updatedAt, "2999-07-05T10:00:05.000Z");

    // An error entry updates recency but never the preview.
    await store.appendEntry(grace.conversationId, {
      type: "error",
      turnId: "t2",
      ts: "2999-07-05T10:01:00.000Z",
      text: "turn failed",
    });
    assert.equal(
      store.listSessions()[0]?.lastPreview,
      "Hi Grace! What are we building today?",
    );

    // A corrupt line in the JSONL is skipped, not fatal.
    await writeFile(
      join(dir, `${grace.conversationId}.jsonl`),
      `${JSON.stringify(transcript[0])}\n{not json}\n${JSON.stringify(transcript[1])}\n`,
      "utf8",
    );
    const repaired = await store.getTranscript(grace.conversationId);
    assert.equal(repaired.length, 2, "corrupt line skipped");

    // A fresh store instance reads the same index back (atomic write landed).
    const reopened = await createTranscriptStore(dir);
    assert.equal(reopened.listSessions().length, 2, "index persisted");

    await store.renameSession(ada.conversationId, "Ada's analytical engine");
    assert.ok(
      store
        .listSessions()
        .some((session) => session.title === "Ada's analytical engine"),
      "rename lands in the index",
    );

    await store.deleteSession(grace.conversationId);
    assert.equal(store.listSessions().length, 1, "delete removes the session");
    assert.deepEqual(
      await store.getTranscript(grace.conversationId),
      [],
      "delete removes the transcript file",
    );

    // The index file itself is valid JSON on disk.
    const rawIndex = JSON.parse(
      await readFile(join(dir, "index.json"), "utf8"),
    );
    assert.equal(rawIndex.sessions.length, 1);

    // A corrupt index is quarantined, not silently treated as empty: the
    // original moves aside where the next persist cannot overwrite it, and
    // the store starts with no sessions.
    await writeFile(join(dir, "index.json"), "{not json", "utf8");
    const quarantined = await createTranscriptStore(dir);
    assert.deepEqual(
      quarantined.listSessions(),
      [],
      "corrupt index starts empty",
    );
    assert.equal(
      await readFile(join(dir, "index.json.corrupt"), "utf8"),
      "{not json",
      "corrupt index preserved aside",
    );
    await quarantined.createSession("post-quarantine session");
    assert.equal(
      await readFile(join(dir, "index.json.corrupt"), "utf8"),
      "{not json",
      "persisting a new index leaves the quarantined copy alone",
    );

    console.log("verify-transcript-store: ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
