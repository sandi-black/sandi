// Renders an ISO timestamp as a Discord timestamp token, so a todo item or
// reminder shows in each viewer's own local time instead of a fixed string.
export function formatDiscordTimestamp(iso: string): string {
  const epochSeconds = Math.floor(new Date(iso).getTime() / 1_000);
  if (!Number.isFinite(epochSeconds)) return iso;
  return `<t:${epochSeconds}:f>`;
}
