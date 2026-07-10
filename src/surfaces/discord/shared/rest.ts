// Shared Discord REST plumbing: the response schemas and the thin fetch
// helpers built on top of discord.js's REST client. Both the Pi extension
// tools and the sandi_js_run runtime helpers talk to the same Discord REST
// surface, so this is the one place that shape is declared. Relative imports
// only (no external repo deps beyond discord.js/zod): the Pi CLI loads
// extension files without the tsconfig path alias, and this module is on
// that dependency chain via pi-extension/discord-tools.ts.
import { REST } from "discord.js";

import { z } from "zod/v4";

export const MAX_DISCORD_FILE_BYTES = 24 * 1024 * 1024;

export const DiscordContextSchema = z.object({
  guildId: z.string().optional(),
  channelId: z.string(),
  parentChannelId: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string(),
});

export const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullable().optional(),
  bot: z.boolean().optional(),
});

export const DiscordAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().optional(),
  content_type: z.string().optional(),
  size: z.number().optional(),
  url: z.string().optional(),
  proxy_url: z.string().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

export const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  timestamp: z.string(),
  edited_timestamp: z.string().nullable().optional(),
  content: z.string(),
  author: DiscordUserSchema,
  attachments: z.array(DiscordAttachmentSchema).optional(),
  pinned: z.boolean().optional(),
});

// The pi-extension copy of this schema also tracked rate_limit_per_user
// (used when reading a channel back after a slowmode update); the runtime
// copy omitted it. Kept here since it is a real, harmless-to-parse Discord
// field and both consumers benefit from having it available.
export const DiscordChannelSchema = z.object({
  id: z.string(),
  type: z.number(),
  name: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  rate_limit_per_user: z.number().nullable().optional(),
  thread_metadata: z
    .object({
      archived: z.boolean().optional(),
      locked: z.boolean().optional(),
      auto_archive_duration: z.number().optional(),
    })
    .optional(),
  applied_tags: z.array(z.string()).optional(),
});

export type DiscordContext = z.infer<typeof DiscordContextSchema>;
export type DiscordUser = z.infer<typeof DiscordUserSchema>;
export type DiscordAttachment = z.infer<typeof DiscordAttachmentSchema>;
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;
export type DiscordChannel = z.infer<typeof DiscordChannelSchema>;

export function readToken(): string {
  const token = process.env["DISCORD_BOT_TOKEN"]?.trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return token;
}

export function createRest(): REST {
  return new REST({ version: "10" }).setToken(readToken());
}

export async function discordGet<T>(
  rest: REST,
  route: `/${string}`,
  schema: z.ZodType<T>,
  query?: URLSearchParams,
): Promise<T> {
  const response =
    query === undefined
      ? await rest.get(route)
      : await rest.get(route, { query });
  return schema.parse(response);
}

// The pi-extension callers pass an audit-log reason; the runtime callers
// currently never do, so `reason` stays optional and unused there.
export async function discordPost<T>(
  rest: REST,
  route: `/${string}`,
  schema: z.ZodType<T>,
  body: unknown,
  reason?: string,
): Promise<T> {
  return schema.parse(await rest.post(route, { body, reason }));
}

export async function discordPatch<T>(
  rest: REST,
  route: `/${string}`,
  schema: z.ZodType<T>,
  body: unknown,
  reason?: string,
): Promise<T> {
  return schema.parse(await rest.patch(route, { body, reason }));
}

export function clamp(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export function limitDiscordContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 2000) return trimmed;
  return `${trimmed.slice(0, 1997)}...`;
}

export function allowedMentions(
  allowMentions: boolean | undefined,
): Record<string, unknown> {
  if (allowMentions) return { parse: ["users", "roles", "everyone"] };
  return { parse: [] };
}

export function safeFilename(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "image.png";
}

export function escapeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
