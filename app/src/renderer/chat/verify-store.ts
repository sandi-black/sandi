import type { QueueState, TranscriptEntry } from "@shared/ipc-contract";

import { useChatStore } from "./store";

// Verifies that late push events and same-session transcript reloads cannot
// leak across conversations or erase a newer queued turn's live UI.
// Run with: npm run verify:chat-store -w app

const emptyQueue = (conversationId: string): QueueState => ({
  conversationId,
  pending: [],
});

function main(): void {
  const provisional: TranscriptEntry = {
    type: "user",
    turnId: "turn-current",
    ts: "2026-07-10T12:00:00.000Z",
    text: "Ada's provisional message",
  };
  const authoritative: TranscriptEntry = {
    type: "assistant",
    turnId: "turn-earlier",
    ts: "2026-07-10T11:59:00.000Z",
    text: "An earlier answer",
  };

  const state = useChatStore.getState();
  state.setActive(
    "conversation-a",
    [provisional],
    emptyQueue("conversation-a"),
  );
  state.beginLiveTurn("turn-next", "conversation-a");
  state.appendDelta("turn-next", "conversation-a", "text", "partial answer");
  state.setQueue({
    conversationId: "conversation-a",
    inflightTurnId: "turn-next",
    pending: [{ turnId: "turn-later", text: "queued" }],
  });

  // This models a disk reload for the prior settled turn completing after the
  // next queued turn has already begun streaming.
  useChatStore
    .getState()
    .setActive("conversation-a", [authoritative], emptyQueue("conversation-a"));
  const reloaded = useChatStore.getState();
  equal(reloaded.liveTurn?.turnId, "turn-next");
  equal(reloaded.liveTurn?.text, "partial answer");
  equal(reloaded.queue?.inflightTurnId, "turn-next");
  deepEqual(
    reloaded.transcript.map((entry) => entry.turnId),
    ["turn-earlier", "turn-current"],
    "the reload keeps optimistic entries absent from its disk snapshot",
  );

  reloaded.appendDelta("turn-next", "conversation-b", "text", "wrong");
  reloaded.appendLiveAttachment("turn-next", "conversation-b", {
    path: "C:\\wrong-conversation.txt",
  });
  reloaded.beginLiveTurn("turn-b", "conversation-b");
  reloaded.setQueue({
    conversationId: "conversation-b",
    pending: [{ turnId: "turn-b", text: "wrong queue" }],
  });
  const isolated = useChatStore.getState();
  equal(isolated.liveTurn?.text, "partial answer");
  deepEqual(isolated.liveAttachments, []);
  equal(isolated.queue?.conversationId, "conversation-a");

  isolated.setActive("conversation-b", [], emptyQueue("conversation-b"));
  const switched = useChatStore.getState();
  equal(switched.liveTurn, undefined);
  deepEqual(switched.liveAttachments, []);
  equal(switched.queue?.conversationId, "conversation-b");

  console.log("verify-chat-store: ok");
}

main();

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(actual: unknown, expected: unknown, message?: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `expected ${expectedJson}, got ${actualJson}`);
  }
}
