import {
  DEFAULT_SESSION_TITLE,
  type TranscriptStore,
} from "./transcript-store";

// After a fresh conversation's first message, name it from that message the way
// the Discord surface names a new thread: a one-off, low-effort model turn on
// the server turns the opening message into a short title, and the local
// session (whose title is otherwise the "New conversation" placeholder forever)
// is renamed in place. Titling is fire-and-forget and never blocks or fails a
// turn: if it cannot produce a title, the placeholder simply stays until a
// later message tries again.

export type AutoTitler = {
  // Names the conversation from `message` when it still carries the default
  // placeholder title and no titling is already in flight for it. Returns the
  // in-flight promise so tests can await it; production callers ignore it.
  maybeTitle(input: { conversationId: string; message: string }): Promise<void>;
};

export function createAutoTitler(input: {
  store: Pick<TranscriptStore, "getSession" | "renameSession">;
  // Asks the server to turn the opening message into a title. Returns undefined
  // when no title could be produced (unpaired, a provider error, a network
  // failure).
  requestTitle(input: {
    conversationId: string;
    message: string;
  }): Promise<string | undefined>;
  // Notifies the renderer that the session list changed so the sidebar and
  // header pick up the new title.
  onTitled(): void;
}): AutoTitler {
  const inFlight = new Set<string>();

  const run = async (
    conversationId: string,
    message: string,
  ): Promise<void> => {
    // Only the first message of a still-unnamed conversation earns a title.
    // Once renamed the title no longer matches the placeholder, so later
    // messages skip here; that same check keeps titling to one message.
    if (!needsTitle(input.store, conversationId)) return;
    if (inFlight.has(conversationId)) return;
    inFlight.add(conversationId);
    try {
      const title = await input.requestTitle({ conversationId, message });
      // A title only lands if the model produced something other than the
      // placeholder itself, and the session still exists and is still unnamed
      // (it was not deleted or renamed while the model ran).
      if (!title || title === DEFAULT_SESSION_TITLE) return;
      if (!needsTitle(input.store, conversationId)) return;
      await input.store.renameSession(conversationId, title);
      input.onTitled();
    } catch (error) {
      // Titling is best-effort; a failure loses a nicety, never a turn.
      console.error("failed to auto-title a conversation", error);
    } finally {
      inFlight.delete(conversationId);
    }
  };

  return {
    maybeTitle({ conversationId, message }) {
      return run(conversationId, message);
    },
  };
}

function needsTitle(
  store: Pick<TranscriptStore, "getSession">,
  conversationId: string,
): boolean {
  const session = store.getSession(conversationId);
  return session?.title === DEFAULT_SESSION_TITLE;
}
