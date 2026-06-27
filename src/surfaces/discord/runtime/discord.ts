import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { promisify, TextDecoder } from "node:util";

import { REST, Routes } from "discord.js";

import { z } from "zod/v4";
import {
  type DeliverySideEffectKind,
  recordDeliverySideEffect,
} from "@/lib/provider/side-effects";
import { readDiscordPlatformContext } from "@/surfaces/discord/runtime/context";
import { resolveGuildId as resolveGuildIdFor } from "@/surfaces/discord/runtime/guild";
import {
  DeleteMessageInputSchema,
  DiscordMessageIdSchema,
  GetMessageInputSchema,
  parseChannelTarget,
} from "@/surfaces/discord/runtime/targets";

const MAX_DISCORD_FILE_BYTES = 24 * 1024 * 1024;
const GIT_BINARY_CHECK_BYTES = 8_000;
const MAX_TEXT_ATTACHMENT_PREVIEW_BYTES = 256 * 1024;
const MAX_SEARCH_MESSAGES = 5_000;
const MAX_SEARCH_RESULTS = 50;
const SEARCH_SNIPPET_CHARS_BEFORE = 80;
const SEARCH_SNIPPET_CHARS_AFTER = 160;
const execFile = promisify(execFileCallback);

const DiscordContextSchema = z.object({
  guildId: z.string().optional(),
  channelId: z.string(),
  parentChannelId: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string(),
});

const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullable().optional(),
  bot: z.boolean().optional(),
});

const DiscordAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().optional(),
  content_type: z.string().optional(),
  size: z.number().optional(),
  url: z.string().optional(),
  proxy_url: z.string().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
});

const DiscordMessageSchema = z.object({
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

const DiscordChannelSchema = z.object({
  id: z.string(),
  type: z.number(),
  name: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
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
export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;
export type DiscordChannel = z.infer<typeof DiscordChannelSchema>;

export type ReadChannelHistoryInput = {
  channel?: string;
  limit?: number;
  beforeMessageId?: string;
  afterMessageId?: string;
};

export type SearchChannelHistoryInput = {
  channel?: string;
  query: string;
  limit?: number;
  maxMessages?: number;
  beforeMessageId?: string;
  caseSensitive?: boolean;
};

export type DiscordHistoryMatch = {
  message: DiscordMessage;
  matchedField: "content" | "attachment";
  matchedText: string;
  snippet: string;
};

export type SearchChannelHistoryResult = {
  matches: DiscordHistoryMatch[];
  searchedMessages: number;
  reachedEnd: boolean;
  oldestMessageId?: string;
};

export type SendMessageInput = {
  channel?: string;
  content: string;
  replyToMessageId?: string;
  allowMentions?: boolean;
};

export type DeleteMessageInput = {
  channel?: string;
  messageId?: string;
  reason?: string;
};

export type SendFileInput = SendMessageInput & {
  path: string;
  filename?: string;
  mimeType?: string;
};

export type SendImageInput = SendMessageInput & {
  path: string;
};

export type ReadAttachmentInput = {
  channel?: string;
  messageId?: string;
  attachmentId?: string;
};

export type ReadAttachmentResult = {
  savedPath: string;
  mimeType: string;
  size: number;
  filename?: string;
  textPreview?: string;
  textPreviewTruncated?: boolean;
};

export function currentContext(): DiscordContext {
  return requireContext();
}

export async function listChannels(): Promise<DiscordChannel[]> {
  const guildId = resolveGuildId(optionalContext());
  return discordGet(
    createRest(),
    Routes.guildChannels(guildId),
    z.array(DiscordChannelSchema),
  );
}

export async function readChannelHistory(
  input: ReadChannelHistoryInput = {},
): Promise<DiscordMessage[]> {
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.channel ?? "current",
    context,
    rest,
  );
  const query = new URLSearchParams({
    limit: String(clamp(input.limit, 50, 1, 100)),
  });
  if (input.beforeMessageId) query.set("before", input.beforeMessageId);
  if (input.afterMessageId) query.set("after", input.afterMessageId);
  return discordGet(
    rest,
    Routes.channelMessages(channelId),
    z.array(DiscordMessageSchema),
    query,
  );
}

export async function searchChannelHistory(
  input: SearchChannelHistoryInput,
): Promise<SearchChannelHistoryResult> {
  const search = buildSearch(input.query, input.caseSensitive ?? false);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.channel ?? "current",
    context,
    rest,
  );
  const limit = clamp(input.limit, 10, 1, MAX_SEARCH_RESULTS);
  const maxMessages = clamp(input.maxMessages, 500, 1, MAX_SEARCH_MESSAGES);
  const matches: DiscordHistoryMatch[] = [];
  let searchedMessages = 0;
  let beforeMessageId = input.beforeMessageId;
  let oldestMessageId: string | undefined;
  let reachedEnd = false;

  while (matches.length < limit && searchedMessages < maxMessages) {
    const pageLimit = Math.min(100, maxMessages - searchedMessages);
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (beforeMessageId) query.set("before", beforeMessageId);
    const page = await discordGet(
      rest,
      Routes.channelMessages(channelId),
      z.array(DiscordMessageSchema),
      query,
    );
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }

    searchedMessages += page.length;
    for (const message of page) {
      const match = findMessageSearchMatch(message, search);
      if (match) matches.push(match);
      if (matches.length >= limit) break;
    }

    const lastMessage = page[page.length - 1];
    if (!lastMessage) {
      reachedEnd = true;
      break;
    }
    oldestMessageId = lastMessage.id;
    beforeMessageId = lastMessage.id;
    if (page.length < pageLimit) {
      reachedEnd = true;
      break;
    }
  }

  const result = {
    matches,
    searchedMessages,
    reachedEnd,
  };
  return oldestMessageId
    ? searchResult({ ...result, oldestMessageId })
    : searchResult(result);
}

type MessageSearch = {
  query: string;
  normalizedQuery: string;
  caseSensitive: boolean;
};

type MessageSearchMatch = {
  matchedField: "content" | "attachment";
  matchedText: string;
};

function searchResult(input: {
  matches: DiscordHistoryMatch[];
  searchedMessages: number;
  reachedEnd: boolean;
  oldestMessageId?: string;
}): SearchChannelHistoryResult {
  const result = {
    matches: input.matches,
    searchedMessages: input.searchedMessages,
    reachedEnd: input.reachedEnd,
  };
  return input.oldestMessageId
    ? { ...result, oldestMessageId: input.oldestMessageId }
    : result;
}

function buildSearch(query: string, caseSensitive: boolean): MessageSearch {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Search query must not be empty.");
  return {
    query: trimmed,
    normalizedQuery: normalizeSearchText(trimmed, caseSensitive),
    caseSensitive,
  };
}

function findMessageSearchMatch(
  message: DiscordMessage,
  search: MessageSearch,
): DiscordHistoryMatch | undefined {
  const match = findSearchMatch(message, search);
  if (!match) return undefined;
  return {
    message,
    matchedField: match.matchedField,
    matchedText: match.matchedText,
    snippet: searchSnippet(match.matchedText, search),
  };
}

function findSearchMatch(
  message: DiscordMessage,
  search: MessageSearch,
): MessageSearchMatch | undefined {
  if (matchesSearch(message.content, search)) {
    return { matchedField: "content", matchedText: message.content };
  }
  for (const attachment of message.attachments ?? []) {
    const filename = attachment.filename;
    if (filename && matchesSearch(filename, search)) {
      return { matchedField: "attachment", matchedText: filename };
    }
  }
  return undefined;
}

function matchesSearch(text: string, search: MessageSearch): boolean {
  return normalizeSearchText(text, search.caseSensitive).includes(
    search.normalizedQuery,
  );
}

function searchSnippet(text: string, search: MessageSearch): string {
  const normalizedText = normalizeSearchText(text, search.caseSensitive);
  const index = normalizedText.indexOf(search.normalizedQuery);
  const matchIndex = Math.max(index, 0);
  const start = Math.max(0, matchIndex - SEARCH_SNIPPET_CHARS_BEFORE);
  const end = Math.min(
    text.length,
    matchIndex + search.query.length + SEARCH_SNIPPET_CHARS_AFTER,
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function normalizeSearchText(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLocaleLowerCase();
}

export async function getMessage(
  input: { channel?: string; messageId?: string } = {},
): Promise<DiscordMessage> {
  const parsed = GetMessageInputSchema.parse(input);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    parsed.channel ?? "current",
    context,
    rest,
  );
  const messageId = parsed.messageId ?? context?.messageId;
  if (!messageId) {
    throw new Error(
      "There is no current Discord message on this turn; pass an explicit messageId.",
    );
  }
  return discordGet(
    rest,
    Routes.channelMessage(channelId, messageId),
    DiscordMessageSchema,
  );
}

export async function sendMessage(
  input: SendMessageInput,
): Promise<DiscordMessage> {
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.channel ?? "current",
    context,
    rest,
  );
  const body: Record<string, unknown> = {
    content: limitDiscordContent(input.content),
    allowed_mentions: allowedMentions(input.allowMentions),
  };
  if (input.replyToMessageId) {
    body["message_reference"] = {
      message_id: DiscordMessageIdSchema.parse(input.replyToMessageId),
      channel_id: channelId,
      fail_if_not_exists: false,
    };
  }
  const message = await discordPost(
    rest,
    Routes.channelMessages(channelId),
    DiscordMessageSchema,
    body,
  );
  await recordDeliverySideEffect("discord:send-message");
  return message;
}

export async function deleteMessage(input: DeleteMessageInput = {}): Promise<{
  channelId: string;
  messageId: string;
}> {
  const parsed = DeleteMessageInputSchema.parse(input);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    parsed.channel ?? "current",
    context,
    rest,
  );
  const messageId = parsed.messageId ?? context?.messageId;
  if (!messageId) {
    throw new Error(
      "There is no current Discord message on this turn; pass an explicit messageId.",
    );
  }
  await rest.delete(Routes.channelMessage(channelId, messageId), {
    reason: parsed.reason,
  });
  return { channelId, messageId };
}

export async function sendFile(input: SendFileInput): Promise<DiscordMessage> {
  const path = resolveAllowedFilePath(input.path);
  const filename = input.filename ?? basename(path);
  const mimeType =
    input.mimeType ?? (await fileMimeType(path)) ?? mimeFromPath(path);
  return sendLocalFile({
    input,
    path,
    filename,
    mimeType,
    sideEffect: "discord:send-file",
    tooLargeLabel: "file",
  });
}

export async function sendImage(
  input: SendImageInput,
): Promise<DiscordMessage> {
  const path = resolveAllowedImagePath(input.path);
  return sendLocalFile({
    input,
    path,
    filename: basename(path),
    mimeType: mimeFromPath(path),
    sideEffect: "discord:send-image",
    tooLargeLabel: "image",
  });
}

async function sendLocalFile(input: {
  input: SendMessageInput;
  path: string;
  filename: string;
  mimeType: string;
  sideEffect: DeliverySideEffectKind;
  tooLargeLabel: string;
}): Promise<DiscordMessage> {
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.input.channel ?? "current",
    context,
    rest,
  );
  const data = await readFile(input.path);
  if (data.byteLength > MAX_DISCORD_FILE_BYTES) {
    throw new Error(
      `Discord ${input.tooLargeLabel} upload is too large: ${data.byteLength} bytes`,
    );
  }
  const body: Record<string, unknown> = {
    content: limitDiscordContent(input.input.content),
    allowed_mentions: allowedMentions(input.input.allowMentions),
  };
  if (input.input.replyToMessageId) {
    body["message_reference"] = {
      message_id: input.input.replyToMessageId,
      channel_id: channelId,
      fail_if_not_exists: false,
    };
  }
  const message = DiscordMessageSchema.parse(
    await discordPostFile(Routes.channelMessages(channelId), body, {
      data,
      filename: safeFilename(input.filename),
      mimeType: input.mimeType,
    }),
  );
  await recordDeliverySideEffect(input.sideEffect);
  return message;
}

export async function readAttachment(
  input: ReadAttachmentInput = {},
): Promise<ReadAttachmentResult> {
  const messageInput: { channel?: string; messageId?: string } = {};
  if (input.channel) messageInput.channel = input.channel;
  if (input.messageId) messageInput.messageId = input.messageId;
  const message = await getMessage(messageInput);
  const attachment = selectAttachment(
    message.attachments ?? [],
    input.attachmentId,
  );
  const downloaded = await downloadAttachment(attachment, message.id);
  return publicAttachmentResult(downloaded);
}

export async function readImageAttachment(
  input: ReadAttachmentInput = {},
): Promise<{
  savedPath: string;
  mimeType: string;
  size: number;
  base64: string;
}> {
  const messageInput: { channel?: string; messageId?: string } = {};
  if (input.channel) messageInput.channel = input.channel;
  if (input.messageId) messageInput.messageId = input.messageId;
  const message = await getMessage(messageInput);
  const attachment = selectImageAttachment(
    message.attachments ?? [],
    input.attachmentId,
  );
  const downloaded = await downloadAttachment(attachment, message.id);
  if (!downloaded.mimeType.startsWith("image/")) {
    throw new Error(`Attachment ${attachment.id} is not an image.`);
  }
  return {
    savedPath: downloaded.savedPath,
    mimeType: downloaded.mimeType,
    size: downloaded.size,
    base64: downloaded.bytes.toString("base64"),
  };
}

async function resolveChannelId(
  rawChannel: string,
  context: DiscordContext | undefined,
  rest: REST,
): Promise<string> {
  const target = parseChannelTarget(rawChannel);
  if (target.kind === "current" || target.kind === "parent") {
    if (!context) {
      throw new Error(
        `There is no current Discord channel on this turn; pass an explicit channel id instead of "${target.kind}".`,
      );
    }
    if (target.kind === "current") return context.threadId ?? context.channelId;
    return context.parentChannelId ?? context.channelId;
  }

  if (target.kind === "id") return target.id;

  const channels = await listChannelsForContext(context, rest);
  const match = channels.find((channel) => channel.name === target.name);
  if (!match) throw new Error(`Could not find channel named ${target.name}`);
  return match.id;
}

async function listChannelsForContext(
  context: DiscordContext | undefined,
  rest: REST,
): Promise<DiscordChannel[]> {
  return discordGet(
    rest,
    Routes.guildChannels(resolveGuildId(context)),
    z.array(DiscordChannelSchema),
  );
}

// The current Discord message context, when this turn originated on Discord.
// Returns undefined on a turn from another surface (a desktop or GitHub turn
// reaching into Discord), where there is no "current" channel or message and
// every helper must name an explicit target.
function optionalContext(): DiscordContext | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  return DiscordContextSchema.parse(JSON.parse(raw));
}

// The current Discord message context, or an error. Used by helpers that only
// make sense on a Discord-originated turn (reading the message that triggered
// the turn, replying in the current channel).
function requireContext(): DiscordContext {
  const context = optionalContext();
  if (!context) throw new Error("Discord platform context is not set");
  return context;
}

function readToken(): string {
  const token = process.env["DISCORD_BOT_TOKEN"]?.trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return token;
}

function createRest(): REST {
  return new REST({ version: "10" }).setToken(readToken());
}

// The guild a helper should operate in: the current context's guild on a
// Discord turn, else the configured DISCORD_GUILD_ID (parsed at the env
// boundary) so a turn from another surface can still resolve channels by name
// and list the server's channels.
function resolveGuildId(context: DiscordContext | undefined): string {
  return resolveGuildIdFor(context?.guildId);
}

async function discordGet<T>(
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

async function discordPost<T>(
  rest: REST,
  route: `/${string}`,
  schema: z.ZodType<T>,
  body: unknown,
): Promise<T> {
  return schema.parse(await rest.post(route, { body }));
}

function discordPostFile(
  route: `/${string}`,
  body: Record<string, unknown>,
  file: {
    data: Buffer;
    filename: string;
    mimeType: string;
  },
): Promise<unknown> {
  const boundary = `sandi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const prefix = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload_json"',
      "Content-Type: application/json",
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const middle = Buffer.from(
    [
      "",
      `--${boundary}`,
      `Content-Disposition: form-data; name="files[0]"; filename="${escapeHeaderValue(file.filename)}"`,
      `Content-Type: ${file.mimeType}`,
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const requestBody = Buffer.concat([
    prefix,
    payload,
    middle,
    file.data,
    suffix,
  ]);

  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: "discord.com",
        path: `/api/v10${route}`,
        headers: {
          Authorization: `Bot ${readToken()}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(requestBody.byteLength),
          "User-Agent": "Sandi Discord Bot",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                `Discord file upload failed (${res.statusCode ?? "unknown"}): ${text}`,
              ),
            );
            return;
          }
          try {
            resolvePromise(JSON.parse(text));
          } catch {
            reject(
              new Error(`Discord file upload returned invalid JSON: ${text}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end(requestBody);
  });
}

type DiscordAttachment = z.infer<typeof DiscordAttachmentSchema>;

async function downloadAttachment(
  attachment: DiscordAttachment,
  messageId: string,
): Promise<ReadAttachmentResult & { bytes: Buffer }> {
  if (!attachment.url)
    throw new Error(`Attachment ${attachment.id} has no downloadable URL.`);
  const response = await fetch(attachment.url);
  if (!response.ok)
    throw new Error(
      `Could not download Discord attachment (${response.status}).`,
    );
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DISCORD_FILE_BYTES) {
    throw new Error(`Discord attachment is too large: ${contentLength} bytes`);
  }
  const fallbackContentType =
    attachment.content_type ??
    response.headers.get("content-type") ??
    "application/octet-stream";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DISCORD_FILE_BYTES) {
    throw new Error(
      `Discord attachment is too large: ${bytes.byteLength} bytes`,
    );
  }
  const safeName = safeFilename(attachment.filename ?? `${attachment.id}`);
  const savedPath = join(
    discordAttachmentsRoot(),
    messageId,
    `${attachment.id}-${safeName}`,
  );
  await mkdir(dirname(savedPath), { recursive: true });
  await writeFile(savedPath, bytes);
  const input = {
    savedPath,
    mimeType: await attachmentMimeType(savedPath, fallbackContentType),
    bytes,
  };
  return attachment.filename
    ? attachmentReadResult({ ...input, filename: attachment.filename })
    : attachmentReadResult(input);
}

function publicAttachmentResult(
  input: ReadAttachmentResult & { bytes: Buffer },
): ReadAttachmentResult {
  const { bytes, ...result } = input;
  return result;
}

function attachmentReadResult(input: {
  savedPath: string;
  mimeType: string;
  bytes: Buffer;
  filename?: string;
}): ReadAttachmentResult & { bytes: Buffer } {
  const base = {
    savedPath: input.savedPath,
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
    bytes: input.bytes,
  };
  const filenameFields = input.filename ? { filename: input.filename } : {};
  if (!isTextLikeContent(input.bytes)) {
    return { ...base, ...filenameFields };
  }
  const previewBytes = input.bytes.subarray(
    0,
    MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  );
  return {
    ...base,
    ...filenameFields,
    textPreview: new TextDecoder("utf-8").decode(previewBytes),
    textPreviewTruncated:
      input.bytes.byteLength > MAX_TEXT_ATTACHMENT_PREVIEW_BYTES,
  };
}

function selectAttachment(
  attachments: DiscordAttachment[],
  attachmentId: string | undefined,
): DiscordAttachment {
  const attachment = attachmentId
    ? attachments.find((item) => item.id === attachmentId)
    : attachments[0];
  if (!attachment) throw new Error("No matching attachment found.");
  return attachment;
}

function selectImageAttachment(
  attachments: DiscordAttachment[],
  attachmentId: string | undefined,
): DiscordAttachment {
  const attachment = attachmentId
    ? attachments.find((item) => item.id === attachmentId)
    : attachments.find(isImageAttachment);
  if (!attachment) throw new Error("No matching image attachment found.");
  if (!isImageAttachment(attachment))
    throw new Error(`Attachment ${attachment.id} is not an image.`);
  return attachment;
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  if (attachment.content_type?.startsWith("image/")) return true;
  const extension = extname(attachment.filename ?? "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
}

function isTextLikeContent(bytes: Buffer): boolean {
  return !bytes.subarray(0, GIT_BINARY_CHECK_BYTES).includes(0);
}

async function attachmentMimeType(
  path: string,
  fallbackContentType: string,
): Promise<string> {
  const detected = await fileMimeType(path);
  if (detected) return detected;
  return fallbackContentType.split(";")[0] ?? "application/octet-stream";
}

async function fileMimeType(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("file", ["--brief", "--mime-type", path]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveAllowedFilePath(path: string): string {
  return resolveAllowedPath({
    path,
    label: "File",
    roots: allowedFileRoots(),
  });
}

function resolveAllowedImagePath(path: string): string {
  return resolveAllowedPath({
    path,
    label: "Image",
    roots: [generatedImagesRoot(), discordAttachmentsRoot(), assetsRoot()],
  });
}

function resolveAllowedPath(input: {
  path: string;
  label: string;
  roots: readonly string[];
}): string {
  const raw = input.path.trim().startsWith("@")
    ? input.path.trim().slice(1)
    : input.path.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(raw);
  if (!input.roots.some((root) => isPathInside(absolute, root))) {
    throw new Error(
      `${input.label} path must be under ${input.roots.join(", ")}. Received: ${absolute}`,
    );
  }
  return absolute;
}

function allowedFileRoots(): string[] {
  const roots = [generatedImagesRoot(), discordAttachmentsRoot(), assetsRoot()];
  const jsRunRoot = process.env["SANDI_JS_RUN_DIR"]?.trim();
  if (jsRunRoot) roots.push(resolve(jsRunRoot));
  return roots;
}

function generatedImagesRoot(): string {
  return resolve(
    process.env["SANDI_GENERATED_IMAGES_ROOT"]?.trim() ||
      join(dataRoot(), "generated-images"),
  );
}

function discordAttachmentsRoot(): string {
  return resolve(
    process.env["SANDI_DISCORD_ATTACHMENTS_ROOT"]?.trim() ||
      join(dataRoot(), "discord-attachments"),
  );
}

function assetsRoot(): string {
  return resolve(process.env["SANDI_ASSETS_ROOT"]?.trim() || "assets");
}

function dataRoot(): string {
  return resolve(process.env["SANDI_DATA_DIR"]?.trim() || "data");
}

function isPathInside(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".css") return "text/css";
  if (ext === ".csv") return "text/csv";
  if (ext === ".gif") return "image/gif";
  if (ext === ".html") return "text/html";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".json") return "application/json";
  if (ext === ".md") return "text/markdown";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".txt") return "text/plain";
  if (ext === ".webp") return "image/webp";
  if (ext === ".yaml" || ext === ".yml") return "application/yaml";
  return "application/octet-stream";
}

function clamp(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function limitDiscordContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 2000) return trimmed;
  return `${trimmed.slice(0, 1997)}...`;
}

function allowedMentions(
  allowMentions: boolean | undefined,
): Record<string, unknown> {
  if (allowMentions) return { parse: ["users", "roles", "everyone"] };
  return { parse: [] };
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized || "image.png";
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
