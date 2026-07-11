import type { QueueState, StagedAttachment } from "@shared/ipc-contract";

import { submitPendingComposer } from "./composer-submission";
import { useChatStore } from "./store";

const emptyQueue = (conversationId: string): QueueState => ({
  conversationId,
  pending: [],
});
const attachment: StagedAttachment = {
  id: "attachment-ada",
  name: "engine-notes.txt",
  mimeType: "text/plain",
  size: 128,
  kind: "file",
  path: "C:\\Ada\\engine-notes.txt",
};
const store = useChatStore.getState();

store.setActive("draft-a", [], emptyQueue("draft-a"));
store.setDraft("draft-a", "  Analyze this engine  ");
store.addStaged("draft-a", attachment);
const firstAttempt = store.beginComposerSubmission("draft-a");
if (!firstAttempt) throw new Error("expected the first submission snapshot");
deepEqual(firstAttempt, {
  conversationId: "draft-a",
  text: "  Analyze this engine  ",
  sentText: "Analyze this engine",
  staged: [attachment],
});
deepEqual(useChatStore.getState().composers["draft-a"], {
  text: "",
  staged: [],
});
equal(
  useChatStore.getState().beginComposerSubmission("draft-a"),
  undefined,
  "a pending IPC call cannot submit the snapshot twice",
);

// A failure after a rapid switch restores only the originating conversation.
let submitCalls = 0;
const failedIpc = deferred<void>();
const failedSubmission = submitPendingComposer({
  submission: firstAttempt,
  submit: (text, attachmentIds) => {
    submitCalls += 1;
    equal(text, "Analyze this engine");
    deepEqual(attachmentIds, ["attachment-ada"]);
    return failedIpc.promise;
  },
  settle: (ok) => store.settleComposerSubmission("draft-a", ok),
});
store.setActive("draft-b", [], emptyQueue("draft-b"));
store.setDraft("draft-b", "A separate draft");
failedIpc.reject(new Error("simulated IPC failure"));
await rejects(failedSubmission, /simulated IPC failure/u);
equal(submitCalls, 1, "failure does not retry automatically");
deepEqual(useChatStore.getState().composers["draft-a"], {
  text: "  Analyze this engine  ",
  staged: [attachment],
});
deepEqual(useChatStore.getState().composers["draft-b"], {
  text: "A separate draft",
  staged: [],
});

// Resending requires a new explicit begin call; success leaves the composer
// cleared and does not restore the consumed snapshot a second time.
const resend = useChatStore.getState().beginComposerSubmission("draft-a");
if (!resend) throw new Error("expected the explicit resend snapshot");
await submitPendingComposer({
  submission: resend,
  submit: async () => {
    submitCalls += 1;
  },
  settle: (ok) => store.settleComposerSubmission("draft-a", ok),
});
equal(submitCalls, 2);
deepEqual(useChatStore.getState().composers["draft-a"], {
  text: "",
  staged: [],
});
equal(useChatStore.getState().pendingSubmissions["draft-a"], undefined);

useChatStore.getState().discardComposer("draft-a");
equal(useChatStore.getState().composers["draft-a"], undefined);

console.log("verify-composer-submission: ok");

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

async function rejects(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`rejection did not match ${pattern}: ${message}`);
  }
  throw new Error("expected promise to reject");
}

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: Error): void;
} {
  let reject = (_error: Error): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((_resolve, fail) => {
    reject = fail;
  });
  return { promise, reject };
}
