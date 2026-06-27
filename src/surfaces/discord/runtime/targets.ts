import { z } from "zod/v4";
import { discordChannelIdFromRef } from "@/surfaces/discord/discord/ids";
import { DiscordSnowflakeSchema } from "@/surfaces/discord/runtime/guild";

// Boundary schemas for the channel and message targets that Discord runtime
// helpers accept from sandi_js_run code. The helpers run inside one trusted
// process, but the argument values are constructed by generated code, so parsing
// them into precise target types here turns a malformed id or empty reference
// into a clear error at the helper boundary instead of an opaque Discord 404.

// A non-empty channel reference: a context keyword ("current"/"parent"), a raw
// snowflake, a <#id> mention, a channel URL, or a #name / name.
export const DiscordChannelRefSchema = z
  .string()
  .trim()
  .min(1, "channel reference must not be empty");

// A Discord message id is a snowflake (digits only).
export const DiscordMessageIdSchema = DiscordSnowflakeSchema;

export const GetMessageInputSchema = z.object({
  channel: DiscordChannelRefSchema.optional(),
  messageId: DiscordMessageIdSchema.optional(),
});

export const DeleteMessageInputSchema = z.object({
  channel: DiscordChannelRefSchema.optional(),
  messageId: DiscordMessageIdSchema.optional(),
  reason: z.string().optional(),
});

export type DiscordChannelTarget =
  | { kind: "current" }
  | { kind: "parent" }
  | { kind: "id"; id: string }
  | { kind: "name"; name: string };

// Parses a channel reference into a precise target: the two context-relative
// keywords, an explicit snowflake (raw, a <#id> mention, or a channel URL), or a
// channel name to resolve against the guild's channels.
export function parseChannelTarget(rawChannel: string): DiscordChannelTarget {
  const raw = DiscordChannelRefSchema.parse(rawChannel);
  if (raw === "current") return { kind: "current" };
  if (raw === "parent") return { kind: "parent" };
  const id = raw.match(/\d{15,25}/u)?.[0];
  if (id) return { kind: "id", id };
  return { kind: "name", name: raw.replace(/^#/u, "") };
}

// Resolves an explicit channel reference (snowflake, <#id> mention, or message
// URL) to a channel id, for helpers like todo that have no guild channel list to
// resolve a bare name against. Throws on an empty or unresolvable reference.
export function explicitChannelId(rawChannel: string): string {
  return discordChannelIdFromRef(DiscordChannelRefSchema.parse(rawChannel));
}
