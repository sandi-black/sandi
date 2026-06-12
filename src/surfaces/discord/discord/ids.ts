const DISCORD_URL_CHANNEL_SEGMENT = /\/channels\/(?:@me|\d+)\/(\d+)/;
const DISCORD_CHANNEL_MENTION = /^<#(\d+)>$/;
const DISCORD_SNOWFLAKE = /^\d+$/;

export function discordChannelIdFromRef(ref: string): string {
  const value = ref.trim();
  const mention = DISCORD_CHANNEL_MENTION.exec(value);
  const mentionedId = mention?.[1];
  if (mentionedId) return mentionedId;

  const url = DISCORD_URL_CHANNEL_SEGMENT.exec(value);
  const urlChannelId = url?.[1];
  if (urlChannelId) return urlChannelId;

  if (DISCORD_SNOWFLAKE.test(value)) return value;

  throw new Error(
    `Expected a Discord channel/thread id, channel mention, or Discord message URL: ${ref}`,
  );
}
