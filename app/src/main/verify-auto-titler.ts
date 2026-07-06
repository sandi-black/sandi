import assert from "node:assert/strict";

import type { SessionSummary } from "@shared/ipc-contract";

import { createAutoTitler } from "./auto-titler";
import { DEFAULT_SESSION_TITLE } from "./transcript-store";

// The auto-titler's orchestration in isolation: a fake store and a fake title
// request stand in for the transcript store and the server call, so this
// pins the guards (title only a still-unnamed conversation, once) without
// Electron or a network.
// Run with: npm run verify:auto-titler -w app

type FakeStore = {
  getSession(conversationId: string): SessionSummary | undefined;
  renameSession(conversationId: string, title: string): Promise<void>;
  setTitle(conversationId: string, title: string): void;
  drop(conversationId: string): void;
  renames: { conversationId: string; title: string }[];
};

function createFakeStore(seed: string[]): FakeStore {
  const titles = new Map<string, string>();
  for (const id of seed) titles.set(id, DEFAULT_SESSION_TITLE);
  const renames: { conversationId: string; title: string }[] = [];
  return {
    getSession(conversationId) {
      const title = titles.get(conversationId);
      if (title === undefined) return undefined;
      return {
        conversationId,
        title,
        createdAt: "2999-01-01T00:00:00.000Z",
        updatedAt: "2999-01-01T00:00:00.000Z",
        lastPreview: "",
      };
    },
    async renameSession(conversationId, title) {
      titles.set(conversationId, title);
      renames.push({ conversationId, title });
    },
    setTitle(conversationId, title) {
      titles.set(conversationId, title);
    },
    drop(conversationId) {
      titles.delete(conversationId);
    },
    renames,
  };
}

async function main(): Promise<void> {
  // Happy path: an unnamed conversation is titled from its message, renamed
  // once, and the renderer is notified.
  {
    const store = createFakeStore(["c1"]);
    let requested = 0;
    let notified = 0;
    const titler = createAutoTitler({
      store,
      requestTitle: async ({ message }) => {
        requested += 1;
        return `Title for ${message}`;
      },
      onTitled: () => {
        notified += 1;
      },
    });
    await titler.maybeTitle({ conversationId: "c1", message: "hello" });
    assert.equal(requested, 1, "the server was asked exactly once");
    assert.deepEqual(
      store.renames,
      [{ conversationId: "c1", title: "Title for hello" }],
      "the session was renamed from the generated title",
    );
    assert.equal(notified, 1, "the renderer was notified once");

    // A second message does not re-title: the conversation is no longer
    // carrying the placeholder.
    await titler.maybeTitle({ conversationId: "c1", message: "again" });
    assert.equal(requested, 1, "a titled conversation is not re-requested");
    assert.equal(store.renames.length, 1, "no second rename");
  }

  // Already named (manually, or by an earlier run): never touched.
  {
    const store = createFakeStore(["c1"]);
    store.setTitle("c1", "A real title");
    let requested = 0;
    const titler = createAutoTitler({
      store,
      requestTitle: async () => {
        requested += 1;
        return "should not happen";
      },
      onTitled: () => {},
    });
    await titler.maybeTitle({ conversationId: "c1", message: "hi" });
    assert.equal(requested, 0, "a named conversation is left alone");
    assert.equal(store.renames.length, 0);
  }

  // The model echoing the placeholder back names nothing.
  {
    const store = createFakeStore(["c1"]);
    const titler = createAutoTitler({
      store,
      requestTitle: async () => DEFAULT_SESSION_TITLE,
      onTitled: () => {
        throw new Error("must not notify when nothing was named");
      },
    });
    await titler.maybeTitle({ conversationId: "c1", message: "  " });
    assert.equal(store.renames.length, 0, "placeholder title is not applied");
  }

  // No title produced (unpaired / provider error): the placeholder stays, and a
  // later message may retry.
  {
    const store = createFakeStore(["c1"]);
    let attempts = 0;
    const titler = createAutoTitler({
      store,
      requestTitle: async () => {
        attempts += 1;
        return attempts === 1 ? undefined : "Second time lucky";
      },
      onTitled: () => {},
    });
    await titler.maybeTitle({ conversationId: "c1", message: "first" });
    assert.equal(store.renames.length, 0, "no rename when no title came back");
    await titler.maybeTitle({ conversationId: "c1", message: "second" });
    assert.deepEqual(
      store.renames,
      [{ conversationId: "c1", title: "Second time lucky" }],
      "a later message retries and succeeds",
    );
  }

  // Concurrent first messages: the in-flight guard means only one request runs,
  // and only one rename lands.
  {
    const store = createFakeStore(["c1"]);
    let requested = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const titler = createAutoTitler({
      store,
      requestTitle: async () => {
        requested += 1;
        await gate;
        return "One winner";
      },
      onTitled: () => {},
    });
    const first = titler.maybeTitle({ conversationId: "c1", message: "a" });
    const second = titler.maybeTitle({ conversationId: "c1", message: "b" });
    release?.();
    await Promise.all([first, second]);
    assert.equal(requested, 1, "only one request ran despite two submits");
    assert.equal(store.renames.length, 1, "only one rename landed");
  }

  // Deleted mid-flight: the model returns a title, but the session is gone, so
  // nothing is renamed and no stale notification fires.
  {
    const store = createFakeStore(["c1"]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const titler = createAutoTitler({
      store,
      requestTitle: async () => {
        await gate;
        return "Too late";
      },
      onTitled: () => {
        throw new Error("must not notify for a deleted conversation");
      },
    });
    const pending = titler.maybeTitle({ conversationId: "c1", message: "x" });
    store.drop("c1");
    release?.();
    await pending;
    assert.equal(store.renames.length, 0, "a deleted session is not renamed");
  }

  console.log("verify-auto-titler: ok");
}

await main();
