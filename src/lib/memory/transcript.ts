import { z } from "zod/v4";

// One human-meaningful exchange reconstructed from a Pi session file. Reasoning
// blocks, usage records, and session bookkeeping are intentionally dropped: a
// recap cares about who said what, not the machinery.
export type TranscriptTurn = {
  role: "user" | "assistant" | "tool";
  text: string;
};

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolCallBlockSchema = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
});

const MessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
});

const MessageEntrySchema = z.object({
  type: z.literal("message"),
  message: MessageSchema,
});

/**
 * Parses a Pi coding-agent session file (JSONL) into an ordered transcript of
 * who-said-what. The on-disk format is owned by the pi packages, so this stays
 * deliberately tolerant: the header line, unknown entry types, and unknown
 * content blocks are skipped rather than throwing, and only the human-meaningful
 * roles (user, assistant, tool result) are surfaced.
 */
export function parsePiSessionTranscript(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = MessageEntrySchema.safeParse(parsed);
    if (!entry.success) continue;
    const turn = turnFromMessage(entry.data.message);
    if (turn) turns.push(turn);
  }
  return turns;
}

function turnFromMessage(
  message: z.infer<typeof MessageSchema>,
): TranscriptTurn | undefined {
  const text = renderContent(message.content);
  if (!text) return undefined;
  if (message.role === "user") return { role: "user", text };
  if (message.role === "assistant") return { role: "assistant", text };
  if (message.role === "toolResult") return { role: "tool", text };
  return undefined;
}

function renderContent(content: string | unknown[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content.trim();
  const parts: string[] = [];
  for (const block of content) {
    const textBlock = TextBlockSchema.safeParse(block);
    if (textBlock.success) {
      const value = textBlock.data.text.trim();
      if (value) parts.push(value);
      continue;
    }
    const toolCall = ToolCallBlockSchema.safeParse(block);
    if (toolCall.success) parts.push(`[uses ${toolCall.data.name}]`);
  }
  return parts.join("\n").trim();
}

/**
 * Renders a transcript for inclusion in a prompt. When the result would exceed
 * maxChars the oldest turns are trimmed and the freshest tail is kept, since the
 * most recent activity is the strongest signal for a recap.
 */
export function formatTranscript(
  turns: TranscriptTurn[],
  options?: { maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? 0;
  const full = turns
    .map((turn) => `${roleLabel(turn.role)}: ${turn.text}`)
    .join("\n\n");
  if (maxChars > 0 && full.length > maxChars) {
    return `… (earlier conversation trimmed) …\n\n${full.slice(full.length - maxChars)}`;
  }
  return full;
}

function roleLabel(role: TranscriptTurn["role"]): string {
  if (role === "user") return "Human";
  if (role === "assistant") return "Sandi";
  return "Tool";
}
