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

const DiscordHistoryLimitSchema = z.number().finite().int().positive();
const DiscordSearchQuerySchema = z
  .string()
  .trim()
  .min(1, "search query must not be empty");
const DiscordMessageContentSchema = z
  .string()
  .trim()
  .min(1, "message content must not be empty");
const MimeTypeSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:;[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/u,
    "mimeType must be a header-safe MIME content type",
  );

export const ReadChannelHistoryInputSchema = z
  .object({
    channel: DiscordChannelRefSchema.optional(),
    limit: DiscordHistoryLimitSchema.optional(),
    beforeMessageId: DiscordMessageIdSchema.optional(),
    afterMessageId: DiscordMessageIdSchema.optional(),
  })
  .refine(
    (input) => !(input.beforeMessageId && input.afterMessageId),
    "readChannelHistory accepts beforeMessageId or afterMessageId, not both",
  );

export const SearchChannelHistoryInputSchema = z.object({
  channel: DiscordChannelRefSchema.optional(),
  query: DiscordSearchQuerySchema,
  limit: DiscordHistoryLimitSchema.optional(),
  maxMessages: DiscordHistoryLimitSchema.optional(),
  beforeMessageId: DiscordMessageIdSchema.optional(),
  caseSensitive: z.boolean().optional(),
});

export const SendMessageInputSchema = z.object({
  channel: DiscordChannelRefSchema.optional(),
  content: DiscordMessageContentSchema,
  replyToMessageId: DiscordMessageIdSchema.optional(),
  allowMentions: z.boolean().optional(),
});

export const SendFileInputSchema = SendMessageInputSchema.extend({
  path: z.string().trim().min(1, "file path must not be empty"),
  filename: z.string().trim().min(1, "filename must not be empty").optional(),
  mimeType: MimeTypeSchema.optional(),
});

export const SendImageInputSchema = SendMessageInputSchema.extend({
  path: z.string().trim().min(1, "image path must not be empty"),
});

export const ReadAttachmentInputSchema = z.object({
  channel: DiscordChannelRefSchema.optional(),
  messageId: DiscordMessageIdSchema.optional(),
  attachmentId: DiscordMessageIdSchema.optional(),
});

export type DiscordChannelTarget =
  | { kind: "current" }
  | { kind: "parent" }
  | { kind: "id"; id: string }
  | { kind: "name"; name: string };

const CHANNEL_SNOWFLAKE = /^\d{15,25}$/u;
const CHANNEL_MENTION = /^<#(\d{15,25})>$/u;
const CHANNEL_URL = /^https?:\/\/\S*\/channels\/(?:@me|\d+)\/(\d{15,25})\b/u;

// Parses a channel reference into a precise target: the two context-relative
// keywords, an explicit snowflake (a bare id, a <#id> mention, or a channel
// URL), or a channel name to resolve against the guild's channels. The id forms
// must match the whole reference (or the channel segment of a URL), so a name
// that merely contains a long digit run is treated as a name, not an id.
export function parseChannelTarget(rawChannel: string): DiscordChannelTarget {
  const raw = DiscordChannelRefSchema.parse(rawChannel);
  if (raw === "current") return { kind: "current" };
  if (raw === "parent") return { kind: "parent" };
  if (CHANNEL_SNOWFLAKE.test(raw)) return { kind: "id", id: raw };
  const mention = CHANNEL_MENTION.exec(raw)?.[1];
  if (mention) return { kind: "id", id: mention };
  const url = CHANNEL_URL.exec(raw)?.[1];
  if (url) return { kind: "id", id: url };
  return { kind: "name", name: raw.replace(/^#/u, "") };
}

// Resolves an explicit channel reference (snowflake, <#id> mention, or message
// URL) to a channel id, for helpers like todo that have no guild channel list to
// resolve a bare name against. Throws on an empty or unresolvable reference.
export function explicitChannelId(rawChannel: string): string {
  return discordChannelIdFromRef(DiscordChannelRefSchema.parse(rawChannel));
}
