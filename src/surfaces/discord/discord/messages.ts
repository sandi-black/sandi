const DISCORD_MESSAGE_LIMIT = 2_000;
const SAFE_MESSAGE_LIMIT = 1_850;

export function chunkDiscordMessage(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const next = remaining.slice(0, SAFE_MESSAGE_LIMIT);
    const splitAt = findSplitPoint(next);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function findSplitPoint(value: string): number {
  const paragraph = value.lastIndexOf("\n\n");
  if (paragraph > 500) return paragraph;

  const newline = value.lastIndexOf("\n");
  if (newline > 500) return newline;

  const space = value.lastIndexOf(" ");
  if (space > 500) return space;

  return value.length;
}
