export const MENTION_THREAD_PLACEHOLDER_TITLE = "new thread";
export const MENTION_THREAD_TITLE_THINKING = "low";
export const MENTION_THREAD_TITLE_TIMEOUT_MS = 60_000;
export const DISCORD_THREAD_TITLE_MAX_LENGTH = 100;

export const THREAD_TITLE_INSTRUCTIONS = [
  "Write a concise Discord thread title for a Sandi conversation.",
  "Base the title only on the user message in the request.",
  "Return exactly one title, with no Markdown, no wrapping quotes, and no explanation.",
  "Use 2 to 8 words when practical.",
  `Keep the title under ${DISCORD_THREAD_TITLE_MAX_LENGTH} characters.`,
  `If there is no meaningful user message, return "${MENTION_THREAD_PLACEHOLDER_TITLE}".`,
].join("\n");

const TITLE_WRAPPERS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
];

export function threadTitleRequestInput(input: {
  authorUsername: string;
  authorDisplayName?: string | undefined;
  channelName: string;
  message: string;
}): string {
  return JSON.stringify(
    {
      task: "Generate a Discord thread title for this Sandi conversation.",
      author: {
        username: input.authorUsername,
        displayName: input.authorDisplayName ?? input.authorUsername,
      },
      channelName: input.channelName,
      userMessage: input.message,
    },
    null,
    2,
  );
}

export function normalizeGeneratedThreadTitle(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/)
    .map(cleanTitleLine)
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;

  const withoutLabel = firstLine
    .replace(/^(?:thread\s+title|title)\s*:\s*/iu, "")
    .trim();
  const unwrapped = unwrapTitle(withoutLabel);
  const withoutTrailingPeriod =
    unwrapped.length > 1 ? unwrapped.replace(/\.$/u, "") : unwrapped;
  const normalized = cleanTitleLine(withoutTrailingPeriod);
  if (!normalized) return undefined;
  return limitThreadTitle(normalized);
}

function cleanTitleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unwrapTitle(value: string): string {
  let current = value.trim();
  for (const [open, close] of TITLE_WRAPPERS) {
    if (current.startsWith(open) && current.endsWith(close)) {
      current = current.slice(1, -1).trim();
    }
  }
  return current;
}

function limitThreadTitle(value: string): string {
  if (value.length <= DISCORD_THREAD_TITLE_MAX_LENGTH) return value;
  return `${value.slice(0, DISCORD_THREAD_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}
