import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const REACTION_STATE_PATH = "reactions/pending.json";
const MAX_EVENTS_PER_CONVERSATION = 50;
const MAX_DRAINED_EVENTS = 25;
const MESSAGE_SNIPPET_LIMIT = 160;

const ReactionEventKindSchema = z.enum(["added", "removed"]);

const PendingReactionEventSchema = z.object({
  kind: ReactionEventKindSchema,
  emoji: z.string(),
  userId: z.string(),
  username: z.string(),
  messageId: z.string(),
  messageUrl: z.string(),
  messageSnippet: z.string(),
  at: z.string(),
});

const ReactionDigestStateSchema = z.object({
  conversations: z.record(z.string(), z.array(PendingReactionEventSchema)),
});

type ReactionEventKind = z.infer<typeof ReactionEventKindSchema>;
type PendingReactionEvent = z.infer<typeof PendingReactionEventSchema>;
type ReactionDigestState = z.infer<typeof ReactionDigestStateSchema>;

const EMPTY_STATE: ReactionDigestState = { conversations: {} };

export type CaptureReactionInput = {
  conversationId: string;
  kind: ReactionEventKind;
  emoji: string;
  userId: string;
  username: string;
  messageId: string;
  messageUrl: string;
  messageContent: string;
  at: string;
};

export class ReactionDigestStore {
  readonly #store: JsonFileStore<ReactionDigestState>;
  #lastUpdate: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.#store = new JsonFileStore(
      join(dataDir, REACTION_STATE_PATH),
      ReactionDigestStateSchema,
    );
  }

  async capture(input: CaptureReactionInput): Promise<void> {
    await this.#withState(async (state) => {
      const current = state.conversations[input.conversationId] ?? [];
      const event: PendingReactionEvent = {
        kind: input.kind,
        emoji: input.emoji,
        userId: input.userId,
        username: input.username,
        messageId: input.messageId,
        messageUrl: input.messageUrl,
        messageSnippet: messageSnippet(input.messageContent),
        at: input.at,
      };
      await this.#store.write({
        conversations: {
          ...state.conversations,
          [input.conversationId]: [...current, event].slice(
            -MAX_EVENTS_PER_CONVERSATION,
          ),
        },
      });
    });
  }

  async drain(conversationId: string): Promise<string | undefined> {
    return this.#withState(async (state) => {
      const events = state.conversations[conversationId] ?? [];
      if (events.length === 0) return undefined;

      const nextConversations = { ...state.conversations };
      delete nextConversations[conversationId];
      await this.#store.write({ conversations: nextConversations });
      return formatReactionDigest(events);
    });
  }

  async #withState<T>(operation: (state: ReactionDigestState) => Promise<T>) {
    const run = this.#lastUpdate.then(async () => {
      const state = await this.#store.read(EMPTY_STATE);
      return operation(state);
    });
    this.#lastUpdate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function formatReactionDigest(events: PendingReactionEvent[]): string {
  const shown = events.slice(-MAX_DRAINED_EVENTS);
  const hidden = events.length - shown.length;
  const lines = [
    "recent_reactions_to_sandi_messages:",
    "  note: These reactions were added or removed since Sandi's last non-event turn in this conversation. Treat them as sideband context or feedback, not automatic requests to respond.",
  ];
  if (hidden > 0) {
    lines.push(`  omitted_older_reactions: ${hidden}`);
  }
  lines.push("  reactions:");
  for (const event of shown) {
    lines.push(
      `    - at: ${event.at}`,
      `      user_id: ${event.userId}`,
      `      username: ${event.username}`,
      `      action: ${event.kind}`,
      `      emoji: ${event.emoji}`,
      `      message_id: ${event.messageId}`,
      `      message_url: ${event.messageUrl}`,
      `      sandi_message_excerpt: ${event.messageSnippet}`,
    );
  }
  return lines.join("\n");
}

function messageSnippet(content: string): string {
  return limitText(
    content.replace(/\s+/g, " ").trim() || "[no text content]",
    MESSAGE_SNIPPET_LIMIT,
  );
}

function limitText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
