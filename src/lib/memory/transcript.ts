import { z } from "zod/v4";

// One human-meaningful exchange reconstructed from a Pi session file. Reasoning
// blocks, usage records, and session bookkeeping are intentionally dropped: a
// recap cares about who said what, not the machinery.
export type TranscriptTurn = {
  role: "user" | "assistant" | "tool";
  text: string;
};

// The result of parsing a session file. `turns` is the readable transcript; the
// counts surface records that could not be read so a caller can warn about
// potentially corrupt session storage instead of silently consolidating from a
// partial transcript. Expected non-message records (the session header, model
// and thinking-level changes, compaction markers, and so on) and known content
// blocks that carry no text (thinking, image) are NOT counted as anomalies; only
// genuinely unreadable data is.
export type ParsedTranscript = {
  turns: TranscriptTurn[];
  unparseableLines: number;
  malformedMessages: number;
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
 * who-said-what. The on-disk format is owned by the pi packages and legitimately
 * interleaves many record and content-block types, so non-message records and
 * known text-free blocks are skipped as normal. A line that is not valid JSON, a
 * record that claims to be a message but fails validation, or a message whose
 * content block announces a known type but fails it (such as a text block with a
 * non-string `text`) is treated as corruption: it is skipped (one bad record
 * should not abort a whole consolidation) but counted so the caller can surface
 * it.
 */
export function parsePiSessionTranscript(jsonl: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  let unparseableLines = 0;
  let malformedMessages = 0;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparseableLines += 1;
      continue;
    }
    const entry = MessageEntrySchema.safeParse(parsed);
    if (entry.success) {
      const result = turnFromMessage(entry.data.message);
      if (result.turn) turns.push(result.turn);
      if (result.malformed) malformedMessages += 1;
      continue;
    }
    // A record that claims to be a message but fails the schema is malformed; a
    // record of any other type is an expected non-message entry, skipped quietly.
    if (recordType(parsed) === "message") malformedMessages += 1;
  }
  return { turns, unparseableLines, malformedMessages };
}

function turnFromMessage(message: z.infer<typeof MessageSchema>): {
  turn: TranscriptTurn | undefined;
  malformed: boolean;
} {
  const { text, malformed } = renderContent(message.content);
  const turn = text ? turnForRole(message.role, text) : undefined;
  return { turn, malformed };
}

function turnForRole(role: string, text: string): TranscriptTurn | undefined {
  if (role === "user") return { role: "user", text };
  if (role === "assistant") return { role: "assistant", text };
  if (role === "toolResult") return { role: "tool", text };
  return undefined;
}

function renderContent(content: string | unknown[] | undefined): {
  text: string;
  malformed: boolean;
} {
  if (content === undefined) return { text: "", malformed: false };
  if (typeof content === "string") {
    return { text: content.trim(), malformed: false };
  }
  const parts: string[] = [];
  let malformed = false;
  for (const block of content) {
    const rendered = renderBlock(block);
    if (rendered.malformed) malformed = true;
    if (rendered.text) parts.push(rendered.text);
  }
  return { text: parts.join("\n").trim(), malformed };
}

function renderBlock(block: unknown): {
  text: string | null;
  malformed: boolean;
} {
  const textBlock = TextBlockSchema.safeParse(block);
  if (textBlock.success) {
    const value = textBlock.data.text.trim();
    return { text: value.length > 0 ? value : null, malformed: false };
  }
  const toolCall = ToolCallBlockSchema.safeParse(block);
  if (toolCall.success) {
    return { text: `[uses ${toolCall.data.name}]`, malformed: false };
  }
  // A block that announces a text or tool-call type but fails its schema (for
  // example a text block whose `text` is not a string), or a block that is not a
  // typed object at all, is malformed content. A block of any other known type
  // (thinking, image, and so on) carries no transcript text and is ignored.
  const type = recordType(block);
  if (type === "text" || type === "toolCall" || type === undefined) {
    return { text: null, malformed: true };
  }
  return { text: null, malformed: false };
}

function recordType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  const type = value["type"];
  return typeof type === "string" ? type : undefined;
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
