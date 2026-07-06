// Surface-neutral conversation title generation. A title is produced by a
// one-off, stateless model turn (sessionMode "none") from a conversation's
// opening user message: the same mechanism the Discord surface uses to name a
// freshly created thread, lifted here so any surface (Discord threads, the
// desktop app's local sidebar) shares one prompt, request shape, and output
// normalization instead of each rolling its own.

// A title turn is a throwaway that must never stall a real turn behind it, so
// it runs at low thinking effort under a short, self-contained timeout.
export const TITLE_TURN_THINKING = "low";
export const TITLE_TURN_TIMEOUT_MS = 60_000;

// The default character ceiling. Surfaces with a stricter platform limit (a
// Discord thread name caps at 100) pass their own.
export const DEFAULT_TITLE_MAX_LENGTH = 100;

/**
 * Builds the model instructions for a title turn. `subject` names what kind of
 * title to write (e.g. "title for a Sandi conversation"); `placeholder` is
 * returned verbatim by the model when the message carries nothing worth
 * titling, so callers can recognize and discard that non-title.
 */
export function conversationTitleInstructions(input: {
  subject: string;
  maxLength: number;
  placeholder: string;
}): string {
  return [
    `Write a concise ${input.subject}.`,
    "Base the title only on the user message in the request.",
    "Return exactly one title, with no Markdown, no wrapping quotes, and no explanation.",
    "Use 2 to 8 words when practical.",
    `Keep the title under ${input.maxLength} characters.`,
    `If there is no meaningful user message, return "${input.placeholder}".`,
  ].join("\n");
}

/**
 * Builds the JSON-stringified turn input a title turn receives. `context` folds
 * in surface-specific fields (a Discord channel name, the originating surface)
 * alongside the author and message the model actually titles from.
 */
export function titleRequestInput(input: {
  task: string;
  authorUsername: string;
  authorDisplayName?: string | undefined;
  message: string;
  context?: Record<string, unknown> | undefined;
}): string {
  return JSON.stringify(
    {
      task: input.task,
      author: {
        username: input.authorUsername,
        displayName: input.authorDisplayName ?? input.authorUsername,
      },
      ...(input.context ?? {}),
      userMessage: input.message,
    },
    null,
    2,
  );
}

const TITLE_WRAPPERS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
];

/**
 * Turns a raw model response into a clean single-line title, or `undefined`
 * when nothing usable remains. Takes the first non-empty line, drops a leading
 * "Title:" / "Thread title:" label, unwraps a single layer of matched quotes or
 * backticks, strips a trailing period and control characters, and truncates to
 * `maxLength` with an ellipsis.
 */
export function normalizeGeneratedTitle(
  raw: string,
  maxLength: number = DEFAULT_TITLE_MAX_LENGTH,
): string | undefined {
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
  return limitTitle(normalized, maxLength);
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

function limitTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
