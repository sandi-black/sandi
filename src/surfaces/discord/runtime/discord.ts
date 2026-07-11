import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify, TextDecoder } from "node:util";

import { type REST, Routes } from "discord.js";

import { z } from "zod/v4";
import { isMissingPathError } from "@/lib/fs-errors";
import {
  type DeliverySideEffectKind,
  recordDeliverySideEffect,
} from "@/lib/provider/side-effects";
import { readDiscordPlatformContext } from "@/surfaces/discord/runtime/context";
import { resolveGuildId as resolveGuildIdFor } from "@/surfaces/discord/runtime/guild";
import {
  DeleteMessageInputSchema,
  GetMessageInputSchema,
  parseChannelTarget,
  ReadAttachmentInputSchema,
  ReadChannelHistoryInputSchema,
  SearchChannelHistoryInputSchema,
  SendFileInputSchema,
  SendImageInputSchema,
  SendMessageInputSchema,
} from "@/surfaces/discord/runtime/targets";
import {
  allowedMentions,
  clamp,
  createRest,
  type DiscordAttachment,
  type DiscordChannel,
  DiscordChannelSchema,
  type DiscordContext,
  type DiscordMessage,
  DiscordMessageSchema,
  discordGet,
  discordPost,
  escapeHeaderValue,
  limitDiscordContent,
  MAX_DISCORD_FILE_BYTES,
  readToken,
  safeFilename,
} from "@/surfaces/discord/shared/rest";

export type { DiscordChannel, DiscordContext, DiscordMessage };

const GIT_BINARY_CHECK_BYTES = 8_000;
const MAX_TEXT_ATTACHMENT_PREVIEW_BYTES = 256 * 1024;
const MAX_SEARCH_MESSAGES = 5_000;
const MAX_SEARCH_RESULTS = 50;
const DISCORD_HTTP_TIMEOUT_MS = 30_000;
const MAX_DISCORD_HTTP_RESPONSE_BYTES = 1024 * 1024;
const FILE_PROBE_TIMEOUT_MS = 3_000;
const FILE_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const SEARCH_SNIPPET_CHARS_BEFORE = 80;
const SEARCH_SNIPPET_CHARS_AFTER = 160;
const execFile = promisify(execFileCallback);

export type ReadChannelHistoryInput = z.infer<
  typeof ReadChannelHistoryInputSchema
>;

export type SearchChannelHistoryInput = z.infer<
  typeof SearchChannelHistoryInputSchema
>;

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

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export type DeleteMessageInput = z.infer<typeof DeleteMessageInputSchema>;

type GetMessageInput = z.infer<typeof GetMessageInputSchema>;

export type SendFileInput = z.infer<typeof SendFileInputSchema>;

export type SendImageInput = z.infer<typeof SendImageInputSchema>;

export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInputSchema>;

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
  const parsed = ReadChannelHistoryInputSchema.parse(input);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    parsed.channel ?? "current",
    context,
    rest,
  );
  const query = new URLSearchParams({
    limit: String(clamp(parsed.limit, 50, 1, 100)),
  });
  if (parsed.beforeMessageId) query.set("before", parsed.beforeMessageId);
  if (parsed.afterMessageId) query.set("after", parsed.afterMessageId);
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
  const parsed = SearchChannelHistoryInputSchema.parse(input);
  const search = buildSearch(parsed.query, parsed.caseSensitive ?? false);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    parsed.channel ?? "current",
    context,
    rest,
  );
  const limit = clamp(parsed.limit, 10, 1, MAX_SEARCH_RESULTS);
  const maxMessages = clamp(parsed.maxMessages, 500, 1, MAX_SEARCH_MESSAGES);
  const matches: DiscordHistoryMatch[] = [];
  let searchedMessages = 0;
  let beforeMessageId = parsed.beforeMessageId;
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
  return getMessageByTarget(GetMessageInputSchema.parse(input));
}

async function getMessageByTarget(
  input: GetMessageInput,
): Promise<DiscordMessage> {
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.channel ?? "current",
    context,
    rest,
  );
  const messageId = input.messageId ?? context?.messageId;
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
  const parsed = SendMessageInputSchema.parse(input);
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    parsed.channel ?? "current",
    context,
    rest,
  );
  const body: Record<string, unknown> = {
    content: limitDiscordContent(parsed.content),
    allowed_mentions: allowedMentions(parsed.allowMentions),
  };
  if (parsed.replyToMessageId) {
    body["message_reference"] = messageReferenceBody(
      parsed.replyToMessageId,
      channelId,
    );
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
  const parsed = SendFileInputSchema.parse(input);
  const file = await readAllowedFilePath(parsed.path);
  const path = file.path;
  const filename = parsed.filename ?? basename(path);
  const mimeType =
    parsed.mimeType ?? (await fileMimeType(path)) ?? mimeFromPath(path);
  return sendLocalFile({
    input: parsed,
    data: file.data,
    filename,
    mimeType,
    sideEffect: "discord:send-file",
  });
}

export async function sendImage(
  input: SendImageInput,
): Promise<DiscordMessage> {
  const parsed = SendImageInputSchema.parse(input);
  const file = await readAllowedFile({
    path: parsed.path,
    label: "Discord image upload",
    roots: [generatedImagesRoot(), discordAttachmentsRoot(), assetsRoot()],
  });
  return sendLocalFile({
    input: parsed,
    data: file.data,
    filename: basename(file.path),
    mimeType: mimeFromPath(file.path),
    sideEffect: "discord:send-image",
  });
}

async function sendLocalFile(input: {
  input: SendMessageInput;
  data: Buffer;
  filename: string;
  mimeType: string;
  sideEffect: DeliverySideEffectKind;
}): Promise<DiscordMessage> {
  const rest = createRest();
  const context = optionalContext();
  const channelId = await resolveChannelId(
    input.input.channel ?? "current",
    context,
    rest,
  );
  const body: Record<string, unknown> = {
    content: limitDiscordContent(input.input.content),
    allowed_mentions: allowedMentions(input.input.allowMentions),
  };
  if (input.input.replyToMessageId) {
    body["message_reference"] = messageReferenceBody(
      input.input.replyToMessageId,
      channelId,
    );
  }
  const message = DiscordMessageSchema.parse(
    await discordPostFile(Routes.channelMessages(channelId), body, {
      data: input.data,
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
  const parsed = ReadAttachmentInputSchema.parse(input);
  const messageInput: { channel?: string; messageId?: string } = {};
  if (parsed.channel) messageInput.channel = parsed.channel;
  if (parsed.messageId) messageInput.messageId = parsed.messageId;
  const message = await getMessageByTarget(messageInput);
  const attachment = selectAttachment(
    message.attachments ?? [],
    parsed.attachmentId,
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
  const parsed = ReadAttachmentInputSchema.parse(input);
  const messageInput: { channel?: string; messageId?: string } = {};
  if (parsed.channel) messageInput.channel = parsed.channel;
  if (parsed.messageId) messageInput.messageId = parsed.messageId;
  const message = await getMessageByTarget(messageInput);
  const attachment = selectImageAttachment(
    message.attachments ?? [],
    parsed.attachmentId,
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

// Builds a Discord message_reference for a reply, parsing the target id at the
// boundary so a malformed reply id fails clearly instead of being posted raw.
function messageReferenceBody(
  replyToMessageId: string,
  channelId: string,
): Record<string, unknown> {
  return {
    message_id: replyToMessageId,
    channel_id: channelId,
    fail_if_not_exists: false,
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
  return readDiscordPlatformContext();
}

// The current Discord message context, or an error. Used by helpers that only
// make sense on a Discord-originated turn (reading the message that triggered
// the turn, replying in the current channel).
function requireContext(): DiscordContext {
  const context = optionalContext();
  if (!context) throw new Error("Discord platform context is not set");
  return context;
}

// The guild a helper should operate in: the current context's guild on a
// Discord turn, else the configured DISCORD_GUILD_ID (parsed at the env
// boundary) so a turn from another surface can still resolve channels by name
// and list the server's channels.
function resolveGuildId(context: DiscordContext | undefined): string {
  return resolveGuildIdFor(context?.guildId);
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
  return requestMultipartJson({
    url: new URL(`https://discord.com/api/v10${route}`),
    headers: {
      Authorization: `Bot ${readToken()}`,
      "User-Agent": "Sandi Discord Bot",
    },
    body,
    file,
  });
}

export function requestMultipartJson(input: {
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: Record<string, unknown>;
  file: {
    data: Buffer;
    filename: string;
    mimeType: string;
  };
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<unknown> {
  const boundary = `sandi-${randomUUID()}`;
  const payload = Buffer.from(JSON.stringify(input.body), "utf8");
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
      `Content-Disposition: form-data; name="files[0]"; filename="${escapeHeaderValue(input.file.filename)}"`,
      `Content-Type: ${input.file.mimeType}`,
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const contentLength =
    prefix.byteLength +
    payload.byteLength +
    middle.byteLength +
    input.file.data.byteLength +
    suffix.byteLength;
  const timeoutMs = input.timeoutMs ?? DISCORD_HTTP_TIMEOUT_MS;
  const maxResponseBytes =
    input.maxResponseBytes ?? MAX_DISCORD_HTTP_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Multipart request timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error(
      "Multipart response byte limit must be a positive integer.",
    );
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let responseStarted = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: { value: unknown } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if ("error" in result) reject(result.error);
      else resolvePromise(result.value);
    };

    const req = openHttpRequest(
      input.url,
      {
        method: "POST",
        headers: {
          ...input.headers,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(contentLength),
        },
      },
      (res) => {
        responseStarted = true;
        let declaredResponseBytes: number | undefined;
        try {
          declaredResponseBytes = parseContentLength(
            res.headers["content-length"] ?? null,
            "Discord file upload response",
          );
        } catch (error) {
          finish({
            error: error instanceof Error ? error : new Error(String(error)),
          });
          res.destroy();
          return;
        }
        if (
          declaredResponseBytes !== undefined &&
          declaredResponseBytes > maxResponseBytes
        ) {
          finish({
            error: new Error(
              `Discord file upload response exceeded ${maxResponseBytes} bytes.`,
            ),
          });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (receivedBytes + chunk.byteLength > maxResponseBytes) {
            finish({
              error: new Error(
                `Discord file upload response exceeded ${maxResponseBytes} bytes.`,
              ),
            });
            res.destroy();
            return;
          }
          receivedBytes += chunk.byteLength;
          chunks.push(chunk);
        });
        res.on("aborted", () => {
          finish({
            error: new Error(
              "Discord file upload response was aborted before completion.",
            ),
          });
        });
        res.on("error", (error) => finish({ error }));
        res.on("end", () => {
          if (settled) return;
          const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            finish({
              error: new Error(
                `Discord file upload failed (${res.statusCode ?? "unknown"}): ${text}`,
              ),
            });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            finish({ value: parsed });
          } catch {
            finish({
              error: new Error(
                `Discord file upload returned invalid JSON: ${text}`,
              ),
            });
          }
        });
        res.on("close", () => {
          if (!res.complete) {
            finish({
              error: new Error(
                "Discord file upload response closed before completion.",
              ),
            });
          }
        });
      },
    );

    req.on("error", (error) => finish({ error }));
    req.on("close", () => {
      if (!responseStarted) {
        finish({
          error: new Error(
            "Discord file upload request closed before receiving a response.",
          ),
        });
      }
    });
    timeout = setTimeout(() => {
      finish({
        error: new Error(
          `Discord file upload exceeded its ${timeoutMs}ms deadline.`,
        ),
      });
      req.destroy();
    }, timeoutMs);
    timeout.unref();

    req.write(prefix);
    req.write(payload);
    req.write(middle);
    req.write(input.file.data);
    req.end(suffix);
  });
}

function openHttpRequest(
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
): ClientRequest {
  if (url.protocol === "https:") {
    return httpsRequest(url, options, onResponse);
  }
  if (url.protocol === "http:") {
    return httpRequest(url, options, onResponse);
  }
  throw new Error(`Unsupported multipart request protocol: ${url.protocol}`);
}

async function downloadAttachment(
  attachment: DiscordAttachment,
  messageId: string,
): Promise<ReadAttachmentResult & { bytes: Buffer }> {
  if (!attachment.url)
    throw new Error(`Attachment ${attachment.id} has no downloadable URL.`);
  assertAttachmentSize(attachment);
  const response = await fetchBoundedBytes(
    attachment.url,
    MAX_DISCORD_FILE_BYTES,
  );
  const fallbackContentType =
    attachment.content_type ??
    response.contentType ??
    "application/octet-stream";
  const bytes = response.bytes;
  const safeName = safeFilename(attachment.filename ?? `${attachment.id}`);
  const savedPath = join(
    discordAttachmentsRoot(),
    safeFilename(messageId),
    `${safeFilename(attachment.id)}-${safeName}`,
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

function assertAttachmentSize(attachment: DiscordAttachment): void {
  if (attachment.size === undefined) return;
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new Error(
      `Discord attachment ${attachment.id} reported an invalid size.`,
    );
  }
  if (attachment.size > MAX_DISCORD_FILE_BYTES) {
    throw new Error(
      `Discord attachment is too large: ${attachment.size} bytes`,
    );
  }
}

export async function fetchBoundedBytes(
  url: string,
  maxBytes: number,
  timeoutMs = DISCORD_HTTP_TIMEOUT_MS,
): Promise<{ bytes: Buffer; contentType: string | undefined }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Download byte limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Download timeout must be a positive integer.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(
        `Discord attachment download exceeded its ${timeoutMs}ms deadline.`,
      ),
    );
  }, timeoutMs);
  timeout.unref();
  try {
    return await fetchBoundedBytesWithSignal(url, maxBytes, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBoundedBytesWithSignal(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string | undefined }> {
  const response = await fetch(url, {
    signal,
  });
  if (!response.ok) {
    await cancelResponseAndThrow(
      response,
      new Error(`Could not download Discord attachment (${response.status}).`),
    );
  }

  let declaredLength: number | undefined;
  try {
    declaredLength = parseContentLength(
      response.headers.get("content-length"),
      "Discord attachment",
    );
  } catch (error) {
    await cancelResponseAndThrow(
      response,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await cancelResponseAndThrow(
      response,
      new Error(`Discord attachment is too large: ${declaredLength} bytes`),
    );
  }
  if (!response.body) {
    throw new Error("Discord attachment response had no body.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (receivedBytes + chunk.value.byteLength > maxBytes) {
      const error = new Error(
        `Discord attachment is too large: more than ${maxBytes} bytes`,
      );
      try {
        await reader.cancel(error);
      } catch (cancelError) {
        throw new AggregateError(
          [error, cancelError],
          "Discord attachment exceeded its byte limit and cancellation failed.",
        );
      }
      throw error;
    }
    receivedBytes += chunk.value.byteLength;
    chunks.push(Buffer.from(chunk.value));
  }

  const contentEncoding = response.headers.get("content-encoding");
  if (
    declaredLength !== undefined &&
    (!contentEncoding || contentEncoding === "identity") &&
    receivedBytes !== declaredLength
  ) {
    throw new Error(
      `Discord attachment ended after ${receivedBytes} of ${declaredLength} declared bytes.`,
    );
  }
  return {
    bytes: Buffer.concat(chunks, receivedBytes),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

async function cancelResponseAndThrow(
  response: Response,
  error: Error,
): Promise<never> {
  if (!response.body) throw error;
  try {
    await response.body.cancel(error);
  } catch (cancelError) {
    throw new AggregateError(
      [error, cancelError],
      `${error.message} Response cancellation also failed.`,
    );
  }
  throw error;
}

function parseContentLength(
  raw: string | null,
  label: string,
): number | undefined {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} returned an invalid Content-Length.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} Content-Length is too large to parse.`);
  }
  return value;
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
    const { stdout } = await execFile(
      "file",
      ["--brief", "--mime-type", path],
      {
        timeout: FILE_PROBE_TIMEOUT_MS,
        maxBuffer: FILE_PROBE_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function readAllowedFilePath(
  path: string,
): Promise<{ path: string; data: Buffer }> {
  return readAllowedFile({
    path,
    label: "Discord file upload",
    roots: allowedFileRoots(),
  });
}

async function readAllowedFile(input: {
  path: string;
  label: string;
  roots: readonly string[];
}): Promise<{ path: string; data: Buffer }> {
  const canonicalPath = await resolveAllowedPath(input);
  const handle = await open(canonicalPath, "r");
  try {
    const openedStat = await handle.stat();
    const currentPath = await resolveAllowedPath({
      ...input,
      path: canonicalPath,
    });
    const currentStat = await stat(currentPath);
    if (
      openedStat.dev !== currentStat.dev ||
      openedStat.ino !== currentStat.ino
    ) {
      throw new Error(`${input.label} changed while it was being authorized.`);
    }
    return {
      path: canonicalPath,
      data: await readBoundedHandle(
        handle,
        MAX_DISCORD_FILE_BYTES,
        input.label,
      ),
    };
  } finally {
    await handle.close();
  }
}

async function resolveAllowedPath(input: {
  path: string;
  label: string;
  roots: readonly string[];
}): Promise<string> {
  const raw = input.path.trim().startsWith("@")
    ? input.path.trim().slice(1)
    : input.path.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(raw);
  const canonicalPath = await realpath(absolute);
  const canonicalRoots = await Promise.all(
    input.roots.map(async (root) => canonicalAllowedRoot(root)),
  );
  if (
    !canonicalRoots.some(
      (root) => root !== undefined && isPathInside(canonicalPath, root),
    )
  ) {
    throw new Error(
      `${input.label} path must resolve under ${input.roots.join(", ")}. Received: ${absolute}`,
    );
  }
  return canonicalPath;
}

async function canonicalAllowedRoot(root: string): Promise<string | undefined> {
  try {
    return await realpath(resolve(root));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
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
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

export async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("File byte limit must be a positive integer.");
  }
  const handle = await open(path, "r");
  try {
    return await readBoundedHandle(handle, maxBytes, label);
  } finally {
    await handle.close();
  }
}

async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const fileStat = await handle.stat();
  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if (fileStat.size > maxBytes) {
    throw new Error(`${label} is too large: ${fileStat.size} bytes`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, maxBytes + 1 - totalBytes),
    );
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    totalBytes += result.bytesRead;
    chunks.push(buffer.subarray(0, result.bytesRead));
  }
  if (totalBytes > maxBytes) {
    throw new Error(`${label} grew beyond ${maxBytes} bytes while reading.`);
  }
  return Buffer.concat(chunks, totalBytes);
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
