import { z } from "zod/v4";

// A Discord snowflake id (guild, channel, thread, or message): Discord renders
// its 64-bit ids as a decimal string, so the precise shape is "digits only".
export const DiscordSnowflakeSchema = z
  .string()
  .trim()
  .regex(/^\d+$/u, "expected a numeric Discord snowflake id");

// The configured fallback guild, parsed once from the DISCORD_GUILD_ID env
// boundary so a raw, unvalidated string never flows into Discord route
// construction. Returns undefined when the variable is unset or empty, and
// throws a clear error when it is set but malformed.
export function configuredGuildId(): string | undefined {
  const raw = process.env["DISCORD_GUILD_ID"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = DiscordSnowflakeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "DISCORD_GUILD_ID must be a numeric Discord snowflake id (digits only).",
    );
  }
  return parsed.data;
}

// The guild a helper should operate in: the per-turn guild (the current Discord
// context's guild) when present, else the configured fallback so a turn from
// another surface can still resolve channels by name and list the server's
// channels. Throws when neither is available.
export function resolveGuildId(contextGuildId: string | undefined): string {
  const guildId = contextGuildId ?? configuredGuildId();
  if (guildId) return guildId;
  throw new Error(
    "This Discord helper requires a guild/server. Set DISCORD_GUILD_ID or run it from a Discord turn.",
  );
}
