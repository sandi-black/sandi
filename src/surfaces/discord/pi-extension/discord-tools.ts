import { Buffer } from "node:buffer";
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

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ChannelType, type REST, Routes } from "discord.js";

import { isMissingPathError } from "../../../lib/fs-errors";
import { assetsRoot, dataRoot } from "../../../lib/pi-extension/roots";
import { recordDeliverySideEffect } from "../../../lib/provider/side-effects";
import { readDiscordPlatformContext } from "../runtime/context";
import {
  allowedMentions,
  clamp,
  createRest,
  type DiscordAttachmentSchema,
  DiscordChannelSchema,
  DiscordMessageSchema,
  DiscordUserSchema,
  discordGet,
  discordPatch,
  discordPost,
  escapeHeaderValue,
  limitDiscordContent,
  MAX_DISCORD_FILE_BYTES,
  readToken,
  safeFilename,
} from "../shared/rest";
import { z } from "zod/v4";

type DiscordContext = {
  guildId?: string;
  channelId: string;
  parentChannelId?: string;
  threadId?: string;
  messageId: string;
};

type DiscordAttachment = z.infer<typeof DiscordAttachmentSchema>;

type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

type DiscordChannel = z.infer<typeof DiscordChannelSchema>;

const DISCORD_HTTP_TIMEOUT_MS = 30_000;
const MAX_DISCORD_HTTP_RESPONSE_BYTES = 1024 * 1024;

const DiscordRoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.number().optional(),
  hoist: z.boolean().optional(),
  managed: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  position: z.number().optional(),
  permissions: z.string().optional(),
});

const DiscordMemberSchema = z.object({
  user: DiscordUserSchema.optional(),
  nick: z.string().nullable().optional(),
  roles: z.array(z.string()).optional(),
  joined_at: z.string().nullable().optional(),
  communication_disabled_until: z.string().nullable().optional(),
});

const DiscordThreadMemberSchema = z.object({
  id: z.string().optional(),
  user_id: z.string().optional(),
  join_timestamp: z.string().optional(),
});

const DiscordThreadListSchema = z.object({
  threads: z.array(DiscordChannelSchema),
  members: z.array(DiscordThreadMemberSchema).optional(),
  has_more: z.boolean().optional(),
});

const DiscordInviteSchema = z.object({
  code: z.string(),
  uses: z.number().nullable().optional(),
  max_uses: z.number().nullable().optional(),
  max_age: z.number().nullable().optional(),
  temporary: z.boolean().optional(),
  expires_at: z.string().nullable().optional(),
});

const DiscordSearchResultSchema = z.object({
  message: z.string().optional(),
  code: z.number().optional(),
  retry_after: z.number().optional(),
  total_results: z.number().optional(),
  messages: z.array(z.array(DiscordMessageSchema)).optional(),
  threads: z.array(DiscordChannelSchema).optional(),
});

const DiscordAuditLogSchema = z.object({
  audit_log_entries: z.array(
    z.object({
      id: z.string(),
      action_type: z.number(),
      target_id: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
      changes: z.array(z.unknown()).optional(),
    }),
  ),
  users: z.array(DiscordUserSchema).optional(),
});

const ChannelRefParam = Type.Optional(
  Type.String({
    description:
      "Channel to target: current, parent, a channel mention like <#123>, a channel/thread ID, or an exact channel name.",
  }),
);

const UserRefParam = Type.String({
  description:
    "Discord user mention like <@123>, raw user ID, or exact username/display query.",
});

const RoleRefParam = Type.String({
  description:
    "Discord role mention like <@&123>, raw role ID, or exact role name.",
});

const ReasonParam = Type.Optional(
  Type.String({
    description: "Audit-log reason. Use a short factual reason.",
  }),
);

export default function discordToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "discord_list_channels",
      label: "List Discord Channels",
      description:
        "List channels in the current Discord server using the Discord SDK.",
      promptSnippet:
        "List Discord channels when you need channel IDs, names, parents, or types.",
      promptGuidelines: [
        "Use this before targeting a named channel if the user did not mention it directly.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const channels = await getGuildChannels(rest, guildId);
        return textResult(formatChannels(channels), {
          guildId,
          count: channels.length,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_read_channel_history",
      label: "Read Discord History",
      description:
        "Read recent Discord message history from the current channel/thread or another channel.",
      promptSnippet:
        "Read recent Discord message history from the current channel/thread or another named/mentioned channel.",
      promptGuidelines: [
        "Use this when the user asks about prior messages, nearby context, a channel, or something said elsewhere.",
        "Prefer current unless the user names or mentions another channel.",
      ],
      parameters: Type.Object({
        channel: ChannelRefParam,
        limit: Type.Optional(
          Type.Number({
            description: "Number of messages to read, from 1 to 100.",
            minimum: 1,
            maximum: 100,
          }),
        ),
        beforeMessageId: Type.Optional(
          Type.String({ description: "Optional message ID for pagination." }),
        ),
        afterMessageId: Type.Optional(
          Type.String({ description: "Optional message ID for pagination." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const query = new URLSearchParams({
          limit: String(clamp(params.limit, 25, 1, 100)),
        });
        if (params.beforeMessageId) query.set("before", params.beforeMessageId);
        if (params.afterMessageId) query.set("after", params.afterMessageId);
        const messages = await discordGet(
          rest,
          Routes.channelMessages(channelId),
          z.array(DiscordMessageSchema),
          query,
        );
        const chronological = messages.toReversed();
        return textResult(formatMessages(channelId, chronological), {
          channelId,
          count: chronological.length,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_get_message",
      label: "Get Discord Message",
      description:
        "Fetch a specific Discord message from a channel using the Discord SDK.",
      promptSnippet:
        "Fetch a specific Discord message before replying to, pinning, deleting, or discussing it.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.Optional(
          Type.String({
            description:
              "Message ID to fetch. Defaults to the message that invoked Sandi.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const messageId = params.messageId ?? context.messageId;
        const message = await getMessage(rest, channelId, messageId);
        return textResult(formatMessage(message), { channelId, messageId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_search_messages",
      label: "Search Discord Messages",
      description:
        "Search messages in the current Discord server. Requires Discord message search availability and Message Content access.",
      promptSnippet:
        "Search server messages when the user asks to find something across channels.",
      promptGuidelines: [
        "Prefer discord_read_channel_history for nearby context; use search for cross-channel lookup.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description: "Text content to search for, up to 1024 characters.",
        }),
        channel: ChannelRefParam,
        author: Type.Optional(UserRefParam),
        limit: Type.Optional(
          Type.Number({
            description: "Number of search matches to return, from 1 to 25.",
            minimum: 1,
            maximum: 25,
          }),
        ),
        offset: Type.Optional(
          Type.Number({
            description: "Search result offset for pagination.",
            minimum: 0,
            maximum: 9975,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const query = new URLSearchParams({
          content: params.query,
          limit: String(clamp(params.limit, 10, 1, 25)),
        });
        if (params.offset !== undefined) {
          query.set("offset", String(clamp(params.offset, 0, 0, 9975)));
        }
        if (params.channel) {
          const channelId = await resolveChannelId(
            params.channel,
            context,
            rest,
          );
          query.append("channel_id", channelId);
        }
        if (params.author) {
          const userId = await resolveUserId(params.author, context, rest);
          query.append("author_id", userId);
        }

        const result = await discordGet(
          rest,
          Routes.guildMessagesSearch(guildId),
          DiscordSearchResultSchema,
          query,
        );
        return textResult(formatSearchResult(result), {
          guildId,
          totalResults: result.total_results ?? 0,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_send_message",
      label: "Send Discord Message",
      description:
        "Send or reply with a message in a Discord channel using the Discord SDK when delivery needs to be an explicit tool side effect.",
      promptSnippet:
        "Use discord_send_message only when Sandi needs an explicit Discord side effect; ordinary final assistant text is posted automatically when no Discord send helper/tool was used.",
      promptGuidelines: [
        "Prefer final assistant text for a single normal reply in the current Discord conversation.",
        "Use this tool when you need to send to a non-current channel, send multiple messages, or otherwise make Discord delivery an explicit side effect.",
        "By default, mentions are suppressed. Enable mentions only when the user clearly asks to notify people or roles.",
      ],
      parameters: Type.Object({
        channel: ChannelRefParam,
        content: Type.String({
          description:
            "Message content to send. Discord limit is 2000 characters.",
        }),
        replyToMessageId: Type.Optional(
          Type.String({ description: "Optional message ID to reply to." }),
        ),
        allowMentions: Type.Optional(
          Type.Boolean({
            description:
              "Whether Discord should notify parsed mentions. Defaults to false.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const body: Record<string, unknown> = {
          content: limitDiscordContent(params.content),
          allowed_mentions: allowedMentions(params.allowMentions),
        };
        if (params.replyToMessageId) {
          body["message_reference"] = {
            message_id: params.replyToMessageId,
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
        return textResult(`Sent message ${message.id} in ${channelId}.`, {
          channelId,
          messageId: message.id,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_read_image_attachment",
      label: "Read Discord Image",
      description:
        "Download and inspect an image attachment from a Discord message. Returns a local path and inline image content so Sandi can see user-sent images.",
      promptSnippet:
        "Read Discord image attachments when the user sends or references an image.",
      promptGuidelines: [
        "Use this before describing, editing, or using a Discord attachment as a visual reference.",
        "The returned savedPath can be passed to image_generate.referencePaths.",
      ],
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.Optional(
          Type.String({
            description:
              "Message ID containing the image. Defaults to the message that invoked Sandi.",
          }),
        ),
        attachmentId: Type.Optional(
          Type.String({
            description:
              "Specific attachment ID. Defaults to the first image attachment.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const messageId = params.messageId ?? context.messageId;
        const message = await getMessage(rest, channelId, messageId);
        const attachment = selectImageAttachment(
          message.attachments ?? [],
          params.attachmentId,
        );
        const downloaded = await downloadAttachment(attachment, message.id);
        return {
          content: [
            { type: "text", text: formatDownloadedImage(downloaded) },
            {
              type: "image",
              data: downloaded.base64,
              mimeType: downloaded.mimeType,
            },
          ],
          details: {
            channelId,
            messageId,
            attachmentId: attachment.id,
            savedPath: downloaded.savedPath,
            mimeType: downloaded.mimeType,
            size: downloaded.size,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_send_image",
      label: "Send Discord Image",
      description:
        "Send a local image file to a Discord channel. Use this to deliver generated images or downloaded image files.",
      promptSnippet:
        "Send image files to Discord after image_generate or when sharing an existing local image.",
      promptGuidelines: [
        "Use discord_send_image to show generated images to Discord users.",
        "Only send Sandi-owned generated/downloaded image files or project assets.",
      ],
      parameters: Type.Object({
        channel: ChannelRefParam,
        path: Type.String({
          description:
            "Local image path to send. Must be under Sandi's generated/downloaded image data or assets.",
        }),
        content: Type.Optional(
          Type.String({
            description: "Optional Discord message content.",
          }),
        ),
        replyToMessageId: Type.Optional(
          Type.String({ description: "Optional message ID to reply to." }),
        ),
        allowMentions: Type.Optional(
          Type.Boolean({
            description:
              "Whether Discord should notify parsed mentions. Defaults to false.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const file = await readAllowedImage(params.path);
        const filePath = file.path;
        const data = file.data;
        const body: Record<string, unknown> = {
          allowed_mentions: allowedMentions(params.allowMentions),
        };
        if (params.content?.trim()) {
          body["content"] = limitDiscordContent(params.content);
        }
        if (params.replyToMessageId) {
          body["message_reference"] = {
            message_id: params.replyToMessageId,
            fail_if_not_exists: false,
          };
        }
        const message = await discordPostFile(
          Routes.channelMessages(channelId),
          body,
          {
            data,
            filename: basename(filePath),
            mimeType: mimeFromPath(filePath),
          },
        );
        const parsed = DiscordMessageSchema.parse(message);
        await recordDeliverySideEffect("discord:send-image");
        return textResult(`Sent image ${basename(filePath)} in ${channelId}.`, {
          channelId,
          messageId: parsed.id,
          path: filePath,
          mimeType: mimeFromPath(filePath),
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_edit_own_message",
      label: "Edit Sandi Message",
      description:
        "Edit a message authored by Sandi. The tool refuses to edit other users' messages.",
      promptSnippet: "Edit one of Sandi's own Discord messages.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.String({ description: "Sandi-authored message ID." }),
        content: Type.String({ description: "Replacement message content." }),
        allowMentions: Type.Optional(
          Type.Boolean({
            description:
              "Whether Discord should notify parsed mentions. Defaults to false.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const [message, bot] = await Promise.all([
          getMessage(rest, channelId, params.messageId),
          getCurrentUser(rest),
        ]);
        if (message.author.id !== bot.id) {
          throw new Error(
            "discord_edit_own_message can only edit Sandi's own messages",
          );
        }
        const edited = await discordPatch(
          rest,
          Routes.channelMessage(channelId, params.messageId),
          DiscordMessageSchema,
          {
            content: limitDiscordContent(params.content),
            allowed_mentions: allowedMentions(params.allowMentions),
          },
        );
        return textResult(`Edited message ${edited.id} in ${channelId}.`, {
          channelId,
          messageId: edited.id,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_delete_message",
      label: "Delete Discord Message",
      description:
        "Delete a Discord message. Deleting other users' messages requires Manage Messages.",
      promptSnippet:
        "Delete a Discord message only when the user clearly asks you to remove it.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.String({ description: "Message ID to delete." }),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        await rest.delete(Routes.channelMessage(channelId, params.messageId), {
          reason: params.reason,
        });
        return textResult(
          `Deleted message ${params.messageId} in ${channelId}.`,
          {
            channelId,
            messageId: params.messageId,
          },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_bulk_delete_messages",
      label: "Bulk Delete Discord Messages",
      description:
        "Bulk delete 2-100 Discord messages. Discord cannot bulk-delete messages older than 14 days.",
      promptSnippet:
        "Bulk delete messages only when the user clearly asks for moderation cleanup.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageIds: Type.Array(Type.String(), {
          description: "Message IDs to delete, 2 to 100.",
          minItems: 2,
          maxItems: 100,
        }),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        await rest.post(Routes.channelBulkDelete(channelId), {
          body: { messages: params.messageIds },
          reason: params.reason,
        });
        return textResult(
          `Bulk-deleted ${params.messageIds.length} messages in ${channelId}.`,
          { channelId, count: params.messageIds.length },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_set_message_pin",
      label: "Pin Discord Message",
      description: "Pin or unpin a Discord message.",
      promptSnippet:
        "Pin or unpin a Discord message when the user asks to preserve or unpin it.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.String({ description: "Message ID to pin or unpin." }),
        pinned: Type.Boolean({ description: "true to pin, false to unpin." }),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const route = Routes.channelMessagesPin(channelId, params.messageId);
        if (params.pinned) {
          await rest.put(route, { reason: params.reason });
        } else {
          await rest.delete(route, { reason: params.reason });
        }
        return textResult(
          `${params.pinned ? "Pinned" : "Unpinned"} message ${params.messageId} in ${channelId}.`,
          { channelId, messageId: params.messageId, pinned: params.pinned },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_set_reaction",
      label: "React To Discord Message",
      description:
        "Add or remove Sandi's own reaction on a Discord message. Emoji may be unicode or custom-name:id.",
      promptSnippet:
        "React to a Discord message when an emoji reaction is the native response.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        messageId: Type.String({ description: "Message ID to react to." }),
        emoji: Type.String({
          description: "Emoji, e.g. ✅ or custom_name:1234567890.",
        }),
        present: Type.Boolean({
          description: "true to add Sandi's reaction, false to remove it.",
        }),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const route = Routes.channelMessageOwnReaction(
          channelId,
          params.messageId,
          encodeURIComponent(params.emoji),
        );
        if (params.present) {
          await rest.put(route);
        } else {
          await rest.delete(route);
        }
        return textResult(
          `${params.present ? "Added" : "Removed"} reaction ${params.emoji} on ${params.messageId}.`,
          {
            channelId,
            messageId: params.messageId,
            emoji: params.emoji,
            present: params.present,
          },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_create_thread",
      label: "Create Discord Thread",
      description:
        "Create a Discord forum post, thread from a message, or standalone text-channel thread.",
      promptSnippet:
        "Create a new forum post/thread when the user asks for a new conversation or wants to branch discussion.",
      promptGuidelines: [
        "If invoked from inside a forum post and no channel is provided, parent targets the parent forum channel.",
        "Use messageId to create a thread from a specific message in a text channel.",
      ],
      parameters: Type.Object({
        channel: ChannelRefParam,
        name: Type.String({
          description: "Thread/post name, 1-100 characters.",
        }),
        message: Type.Optional(
          Type.String({
            description:
              "Initial message for a forum/media post. Also used as the first message when Discord requires one.",
          }),
        ),
        messageId: Type.Optional(
          Type.String({
            description:
              "Existing message ID to start a thread from. Omit for forum post or standalone thread.",
          }),
        ),
        privateThread: Type.Optional(
          Type.Boolean({
            description:
              "Create a private thread when starting without a message in a text channel.",
          }),
        ),
        appliedTagIds: Type.Optional(
          Type.Array(Type.String(), {
            description: "Forum tag IDs to apply, up to 5.",
            maxItems: 5,
          }),
        ),
        autoArchiveMinutes: Type.Optional(
          Type.Number({
            description: "Auto-archive duration in minutes.",
          }),
        ),
        slowmodeSeconds: Type.Optional(
          Type.Number({
            description: "Thread slowmode in seconds.",
            minimum: 0,
            maximum: 21600,
          }),
        ),
        allowMentions: Type.Optional(
          Type.Boolean({
            description:
              "Whether Discord should notify parsed mentions in the starter message. Defaults to false.",
          }),
        ),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveThreadParentId(
          params.channel,
          context,
          rest,
        );
        const body: Record<string, unknown> = {
          name: limitLength(params.name, 100),
        };
        if (params.autoArchiveMinutes !== undefined) {
          body["auto_archive_duration"] = params.autoArchiveMinutes;
        }
        if (params.slowmodeSeconds !== undefined) {
          body["rate_limit_per_user"] = clamp(
            params.slowmodeSeconds,
            0,
            0,
            21600,
          );
        }

        if (params.messageId) {
          const thread = await discordPost(
            rest,
            Routes.threads(channelId, params.messageId),
            DiscordChannelSchema,
            body,
            params.reason,
          );
          return textResult(formatChannel(thread), {
            channelId: thread.id,
            parentChannelId: channelId,
          });
        }

        if (
          params.message !== undefined ||
          params.appliedTagIds !== undefined
        ) {
          body["message"] = {
            content: limitDiscordContent(
              params.message ?? `Started ${limitLength(params.name, 100)}`,
            ),
            allowed_mentions: allowedMentions(params.allowMentions),
          };
          if (params.appliedTagIds) body["applied_tags"] = params.appliedTagIds;
        } else if (params.privateThread !== undefined) {
          body["type"] = params.privateThread
            ? ChannelType.PrivateThread
            : ChannelType.PublicThread;
        }

        const thread = await discordPost(
          rest,
          Routes.threads(channelId),
          DiscordChannelSchema,
          body,
          params.reason,
        );
        return textResult(formatChannel(thread), {
          channelId: thread.id,
          parentChannelId: channelId,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_update_thread",
      label: "Update Discord Thread",
      description:
        "Rename, archive/unarchive, lock/unlock, slowmode, or retag a Discord thread/forum post.",
      promptSnippet:
        "Update a Discord thread when the user asks to rename, archive, lock, unlock, or retag it.",
      parameters: Type.Object({
        thread: ChannelRefParam,
        name: Type.Optional(Type.String({ description: "New thread name." })),
        archived: Type.Optional(
          Type.Boolean({ description: "Archive or unarchive the thread." }),
        ),
        locked: Type.Optional(
          Type.Boolean({ description: "Lock or unlock the thread." }),
        ),
        slowmodeSeconds: Type.Optional(
          Type.Number({
            description: "Slowmode in seconds.",
            minimum: 0,
            maximum: 21600,
          }),
        ),
        appliedTagIds: Type.Optional(
          Type.Array(Type.String(), {
            description: "Replacement forum tag IDs, up to 5.",
            maxItems: 5,
          }),
        ),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const threadId = await resolveChannelId(
          params.thread ?? "current",
          context,
          rest,
        );
        const body: Record<string, unknown> = {};
        if (params.name) body["name"] = limitLength(params.name, 100);
        if (params.archived !== undefined) body["archived"] = params.archived;
        if (params.locked !== undefined) body["locked"] = params.locked;
        if (params.slowmodeSeconds !== undefined) {
          body["rate_limit_per_user"] = clamp(
            params.slowmodeSeconds,
            0,
            0,
            21600,
          );
        }
        if (params.appliedTagIds) body["applied_tags"] = params.appliedTagIds;
        if (Object.keys(body).length === 0) {
          throw new Error("No thread update fields were provided");
        }
        const thread = await discordPatch(
          rest,
          Routes.channel(threadId),
          DiscordChannelSchema,
          body,
          params.reason,
        );
        return textResult(formatChannel(thread), { threadId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_list_threads",
      label: "List Discord Threads",
      description:
        "List active guild threads or archived threads for a channel/forum.",
      promptSnippet:
        "List Discord threads when the user asks what conversations/posts exist.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        archived: Type.Optional(
          Type.String({
            description:
              "Archived thread kind: public, private, or joined-private. Omit for active guild threads.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Archived thread limit.",
            minimum: 1,
            maximum: 100,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const query = new URLSearchParams({
          limit: String(clamp(params.limit, 50, 1, 100)),
        });
        const archived = params.archived?.trim();
        const threads =
          archived === undefined
            ? await discordGet(
                rest,
                Routes.guildActiveThreads(guildId),
                DiscordThreadListSchema,
              )
            : await getArchivedThreads(
                rest,
                context,
                archived,
                params.channel,
                query,
              );
        return textResult(formatThreadList(threads), {
          guildId,
          count: threads.threads.length,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_manage_thread_member",
      label: "Manage Thread Member",
      description: "Add or remove a user from a Discord thread.",
      promptSnippet:
        "Add or remove thread members when the user asks to bring someone into, or remove someone from, a thread.",
      parameters: Type.Object({
        thread: ChannelRefParam,
        user: UserRefParam,
        present: Type.Boolean({
          description: "true to add the user, false to remove them.",
        }),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const threadId = await resolveChannelId(
          params.thread ?? "current",
          context,
          rest,
        );
        const userId = await resolveUserId(params.user, context, rest);
        const route = Routes.threadMembers(threadId, userId);
        if (params.present) {
          await rest.put(route);
        } else {
          await rest.delete(route);
        }
        return textResult(
          `${params.present ? "Added" : "Removed"} ${userId} ${params.present ? "to" : "from"} thread ${threadId}.`,
          { threadId, userId, present: params.present },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_search_members",
      label: "Search Discord Members",
      description: "Search members in the current Discord server.",
      promptSnippet:
        "Search Discord members before role, moderation, or mention-sensitive actions.",
      parameters: Type.Object({
        query: Type.String({
          description: "Username or nickname prefix to search.",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Number of members, 1 to 100.",
            minimum: 1,
            maximum: 100,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const query = new URLSearchParams({
          query: params.query,
          limit: String(clamp(params.limit, 10, 1, 100)),
        });
        const members = await discordGet(
          rest,
          Routes.guildMembersSearch(guildId),
          z.array(DiscordMemberSchema),
          query,
        );
        return textResult(formatMembers(members), {
          guildId,
          count: members.length,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_get_member",
      label: "Get Discord Member",
      description:
        "Fetch a Discord server member by mention, id, or search query.",
      promptSnippet:
        "Get a Discord member before role or moderation actions when exact identity matters.",
      parameters: Type.Object({
        user: UserRefParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = await resolveUserId(params.user, context, rest);
        const member = await discordGet(
          rest,
          Routes.guildMember(guildId, userId),
          DiscordMemberSchema,
        );
        return textResult(formatMember(member), { guildId, userId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_list_roles",
      label: "List Discord Roles",
      description: "List roles in the current Discord server.",
      promptSnippet:
        "List Discord roles before adding or removing roles by name.",
      parameters: Type.Object({}),
      async execute() {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const roles = await getGuildRoles(rest, guildId);
        return textResult(formatRoles(roles), { guildId, count: roles.length });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_manage_member_role",
      label: "Manage Member Role",
      description: "Add or remove a role from a Discord server member.",
      promptSnippet:
        "Add or remove a member role only when the user clearly asks for that role change.",
      parameters: Type.Object({
        user: UserRefParam,
        role: RoleRefParam,
        present: Type.Boolean({
          description: "true to add the role, false to remove it.",
        }),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = await resolveUserId(params.user, context, rest);
        const roleId = await resolveRoleId(params.role, context, rest);
        const route = Routes.guildMemberRole(guildId, userId, roleId);
        if (params.present) {
          await rest.put(route, { reason: params.reason });
        } else {
          await rest.delete(route, { reason: params.reason });
        }
        return textResult(
          `${params.present ? "Added" : "Removed"} role ${roleId} ${params.present ? "to" : "from"} ${userId}.`,
          { guildId, userId, roleId, present: params.present },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_timeout_member",
      label: "Timeout Discord Member",
      description:
        "Set or clear a Discord member timeout. Requires Moderate Members and Discord role hierarchy to allow it.",
      promptSnippet:
        "Timeout or clear timeout only when the user clearly asks for moderation.",
      parameters: Type.Object({
        user: UserRefParam,
        minutes: Type.Number({
          description: "Timeout duration in minutes. Use 0 to clear timeout.",
          minimum: 0,
        }),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = await resolveUserId(params.user, context, rest);
        const until =
          params.minutes <= 0
            ? null
            : new Date(
                Date.now() + Math.trunc(params.minutes) * 60_000,
              ).toISOString();
        const member = await discordPatch(
          rest,
          Routes.guildMember(guildId, userId),
          DiscordMemberSchema,
          { communication_disabled_until: until },
          params.reason,
        );
        return textResult(formatMember(member), { guildId, userId, until });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_kick_member",
      label: "Kick Discord Member",
      description:
        "Kick a Discord member from the server. Requires Kick Members and role hierarchy to allow it.",
      promptSnippet:
        "Kick a member only when the user explicitly asks for that moderation action.",
      parameters: Type.Object({
        user: UserRefParam,
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = await resolveUserId(params.user, context, rest);
        await rest.delete(Routes.guildMember(guildId, userId), {
          reason: params.reason,
        });
        return textResult(`Kicked member ${userId}.`, { guildId, userId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_ban_member",
      label: "Ban Discord Member",
      description:
        "Ban a Discord user from the server. Requires Ban Members and role hierarchy to allow it.",
      promptSnippet:
        "Ban a user only when the user explicitly asks for that moderation action.",
      parameters: Type.Object({
        user: UserRefParam,
        deleteMessageSeconds: Type.Optional(
          Type.Number({
            description: "Seconds of message history to delete, 0 to 604800.",
            minimum: 0,
            maximum: 604800,
          }),
        ),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = await resolveUserId(params.user, context, rest);
        await rest.put(Routes.guildBan(guildId, userId), {
          body: {
            delete_message_seconds: clamp(
              params.deleteMessageSeconds,
              0,
              0,
              604800,
            ),
          },
          reason: params.reason,
        });
        return textResult(`Banned user ${userId}.`, { guildId, userId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_unban_member",
      label: "Unban Discord Member",
      description: "Remove a Discord server ban.",
      promptSnippet:
        "Unban a user only when the user explicitly asks for that moderation action.",
      parameters: Type.Object({
        user: UserRefParam,
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const userId = requireSnowflake(params.user, "user");
        await rest.delete(Routes.guildBan(guildId, userId), {
          reason: params.reason,
        });
        return textResult(`Unbanned user ${userId}.`, { guildId, userId });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_create_invite",
      label: "Create Discord Invite",
      description:
        "Create a Discord channel invite. Defaults to a 24-hour, one-use invite.",
      promptSnippet:
        "Create invites only when the user asks to invite someone or generate a link.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        maxAgeSeconds: Type.Optional(
          Type.Number({
            description: "Invite lifetime in seconds. Defaults to 86400.",
            minimum: 0,
          }),
        ),
        maxUses: Type.Optional(
          Type.Number({
            description:
              "Max uses. Defaults to 1. Use 0 for unlimited only if explicitly requested.",
            minimum: 0,
          }),
        ),
        temporary: Type.Optional(
          Type.Boolean({ description: "Grant temporary membership." }),
        ),
        unique: Type.Optional(
          Type.Boolean({
            description: "Create a unique invite. Defaults to true.",
          }),
        ),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const invite = await discordPost(
          rest,
          Routes.channelInvites(channelId),
          DiscordInviteSchema,
          {
            max_age: clamp(params.maxAgeSeconds, 86_400, 0, 604_800),
            max_uses: clamp(params.maxUses, 1, 0, 100),
            temporary: params.temporary ?? false,
            unique: params.unique ?? true,
          },
          params.reason,
        );
        return textResult(`Created invite https://discord.gg/${invite.code}`, {
          channelId,
          code: invite.code,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_create_channel",
      label: "Create Discord Channel",
      description:
        "Create a basic text, forum, voice, or category channel in the current Discord server.",
      promptSnippet:
        "Create a channel only when the user asks to add a new Discord channel.",
      parameters: Type.Object({
        name: Type.String({ description: "Channel name, 1-100 characters." }),
        kind: Type.Optional(
          Type.String({
            description: "text, forum, voice, or category. Defaults to text.",
          }),
        ),
        parent: ChannelRefParam,
        topic: Type.Optional(Type.String({ description: "Text/forum topic." })),
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const body: Record<string, unknown> = {
          name: limitLength(params.name, 100),
          type: channelKindToType(params.kind),
        };
        if (params.parent) {
          body["parent_id"] = await resolveChannelId(
            params.parent,
            context,
            rest,
          );
        }
        if (params.topic) body["topic"] = limitLength(params.topic, 1024);
        const channel = await discordPost(
          rest,
          Routes.guildChannels(guildId),
          DiscordChannelSchema,
          body,
          params.reason,
        );
        return textResult(formatChannel(channel), {
          guildId,
          channelId: channel.id,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_update_channel",
      label: "Update Discord Channel",
      description:
        "Rename a channel or update topic, nsfw flag, slowmode, or parent category.",
      promptSnippet:
        "Update channel settings when the user asks to rename or organize a channel.",
      parameters: Type.Object({
        channel: ChannelRefParam,
        name: Type.Optional(Type.String({ description: "New channel name." })),
        topic: Type.Optional(
          Type.String({ description: "New channel topic." }),
        ),
        nsfw: Type.Optional(
          Type.Boolean({ description: "Set age-restricted flag." }),
        ),
        slowmodeSeconds: Type.Optional(
          Type.Number({
            description: "Slowmode seconds.",
            minimum: 0,
            maximum: 21600,
          }),
        ),
        parent: ChannelRefParam,
        reason: ReasonParam,
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const channelId = await resolveChannelId(
          params.channel ?? "current",
          context,
          rest,
        );
        const body: Record<string, unknown> = {};
        if (params.name) body["name"] = limitLength(params.name, 100);
        if (params.topic) body["topic"] = limitLength(params.topic, 1024);
        if (params.nsfw !== undefined) body["nsfw"] = params.nsfw;
        if (params.slowmodeSeconds !== undefined) {
          body["rate_limit_per_user"] = clamp(
            params.slowmodeSeconds,
            0,
            0,
            21600,
          );
        }
        if (params.parent) {
          body["parent_id"] = await resolveChannelId(
            params.parent,
            context,
            rest,
          );
        }
        if (Object.keys(body).length === 0) {
          throw new Error("No channel update fields were provided");
        }
        const channel = await discordPatch(
          rest,
          Routes.channel(channelId),
          DiscordChannelSchema,
          body,
          params.reason,
        );
        return textResult(formatChannel(channel), { channelId: channel.id });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discord_read_audit_log",
      label: "Read Discord Audit Log",
      description: "Read recent Discord server audit-log entries.",
      promptSnippet:
        "Read the audit log when diagnosing server changes or moderation actions.",
      parameters: Type.Object({
        user: Type.Optional(UserRefParam),
        actionType: Type.Optional(
          Type.Number({
            description:
              "Optional Discord audit-log action type integer, if known.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Number of entries, 1 to 100.",
            minimum: 1,
            maximum: 100,
          }),
        ),
        beforeEntryId: Type.Optional(
          Type.String({
            description: "Optional audit-log entry ID for pagination.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const rest = createRest();
        const context = readContext();
        const guildId = requireGuildId(context);
        const query = new URLSearchParams({
          limit: String(clamp(params.limit, 25, 1, 100)),
        });
        if (params.user) {
          query.set("user_id", await resolveUserId(params.user, context, rest));
        }
        if (params.actionType !== undefined) {
          query.set("action_type", String(Math.trunc(params.actionType)));
        }
        if (params.beforeEntryId) query.set("before", params.beforeEntryId);
        const auditLog = await discordGet(
          rest,
          Routes.guildAuditLog(guildId),
          DiscordAuditLogSchema,
          query,
        );
        return textResult(formatAuditLog(auditLog), {
          guildId,
          count: auditLog.audit_log_entries.length,
        });
      },
    }),
  );
}

function readContext(): DiscordContext {
  const platformContext = readDiscordPlatformContext();
  if (!platformContext) {
    throw new Error("Discord platform context is not set");
  }
  const context: DiscordContext = {
    channelId: platformContext.channelId,
    messageId: platformContext.messageId,
  };
  if (platformContext.guildId) context.guildId = platformContext.guildId;
  if (platformContext.parentChannelId) {
    context.parentChannelId = platformContext.parentChannelId;
  }
  if (platformContext.threadId) context.threadId = platformContext.threadId;
  return context;
}

function requireGuildId(context: DiscordContext): string {
  if (context.guildId) return context.guildId;
  throw new Error("This Discord tool requires a guild/server context");
}

async function discordPostFile(
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

function requestMultipartJson(input: {
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

async function getCurrentUser(
  rest: REST,
): Promise<z.infer<typeof DiscordUserSchema>> {
  return discordGet(rest, Routes.user(), DiscordUserSchema);
}

async function getMessage(
  rest: REST,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage> {
  return discordGet(
    rest,
    Routes.channelMessage(channelId, messageId),
    DiscordMessageSchema,
  );
}

async function getGuildChannels(
  rest: REST,
  guildId: string,
): Promise<DiscordChannel[]> {
  return discordGet(
    rest,
    Routes.guildChannels(guildId),
    z.array(DiscordChannelSchema),
  );
}

async function getGuildRoles(
  rest: REST,
  guildId: string,
): Promise<z.infer<typeof DiscordRoleSchema>[]> {
  return discordGet(
    rest,
    Routes.guildRoles(guildId),
    z.array(DiscordRoleSchema),
  );
}

async function resolveChannelId(
  rawChannel: string,
  context: DiscordContext,
  rest: REST,
): Promise<string> {
  const raw = rawChannel.trim();
  if (raw === "current") return context.threadId ?? context.channelId;
  if (raw === "parent") return context.parentChannelId ?? context.channelId;

  const id = snowflakeFrom(raw);
  if (id) return id;

  const guildId = requireGuildId(context);
  const channels = await getGuildChannels(rest, guildId);
  const wanted = raw.replace(/^#/, "");
  const match = channels.find((channel) => channel.name === wanted);
  if (!match) throw new Error(`Could not find channel named ${raw}`);
  return match.id;
}

async function resolveThreadParentId(
  rawChannel: string | undefined,
  context: DiscordContext,
  rest: REST,
): Promise<string> {
  if (rawChannel) return resolveChannelId(rawChannel, context, rest);
  return context.parentChannelId ?? context.channelId;
}

async function resolveUserId(
  rawUser: string,
  context: DiscordContext,
  rest: REST,
): Promise<string> {
  const id = snowflakeFrom(rawUser);
  if (id) return id;

  const guildId = requireGuildId(context);
  const query = new URLSearchParams({
    query: rawUser.trim(),
    limit: "5",
  });
  const members = await discordGet(
    rest,
    Routes.guildMembersSearch(guildId),
    z.array(DiscordMemberSchema),
    query,
  );
  const exact = members.find((member) => {
    const user = member.user;
    return (
      user?.username === rawUser ||
      user?.global_name === rawUser ||
      member.nick === rawUser
    );
  });
  const match = exact ?? members[0];
  const userId = match?.user?.id;
  if (!userId) throw new Error(`Could not resolve Discord user ${rawUser}`);
  return userId;
}

async function resolveRoleId(
  rawRole: string,
  context: DiscordContext,
  rest: REST,
): Promise<string> {
  const id = snowflakeFrom(rawRole);
  if (id) return id;

  const guildId = requireGuildId(context);
  const roles = await getGuildRoles(rest, guildId);
  const match = roles.find((role) => role.name === rawRole.trim());
  if (!match) throw new Error(`Could not resolve Discord role ${rawRole}`);
  return match.id;
}

async function getArchivedThreads(
  rest: REST,
  context: DiscordContext,
  archived: string,
  rawChannel: string | undefined,
  query: URLSearchParams,
): Promise<z.infer<typeof DiscordThreadListSchema>> {
  const channelId = await resolveThreadParentId(rawChannel, context, rest);
  if (archived === "public" || archived === "private") {
    return discordGet(
      rest,
      Routes.channelThreads(channelId, archived),
      DiscordThreadListSchema,
      query,
    );
  }
  if (archived === "joined-private") {
    return discordGet(
      rest,
      Routes.channelJoinedArchivedThreads(channelId),
      DiscordThreadListSchema,
      query,
    );
  }
  throw new Error("archived must be public, private, or joined-private");
}

function requireSnowflake(raw: string, label: string): string {
  const id = snowflakeFrom(raw);
  if (!id) throw new Error(`Expected ${label} to be a Discord ID or mention`);
  return id;
}

function snowflakeFrom(raw: string): string | undefined {
  const match = raw.match(/\d{15,25}/);
  return match?.[0];
}

function limitLength(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

async function downloadAttachment(
  attachment: DiscordAttachment,
  messageId: string,
): Promise<{
  savedPath: string;
  mimeType: string;
  base64: string;
  size: number;
}> {
  if (!attachment.url) {
    throw new Error(`Attachment ${attachment.id} has no downloadable URL.`);
  }
  assertAttachmentSize(attachment);
  const response = await fetchBoundedBytes(
    attachment.url,
    MAX_DISCORD_FILE_BYTES,
  );
  const contentType =
    attachment.content_type ?? response.contentType ?? "image/png";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Attachment ${attachment.id} is not an image.`);
  }
  const bytes = response.bytes;
  const safeName = safeFilename(attachment.filename ?? `${attachment.id}.png`);
  const savedPath = join(
    discordAttachmentsRoot(),
    safeFilename(messageId),
    `${safeFilename(attachment.id)}-${safeName}`,
  );
  await mkdir(dirname(savedPath), { recursive: true });
  await writeFile(savedPath, bytes);
  return {
    savedPath,
    mimeType: contentType.split(";")[0] ?? "image/png",
    base64: bytes.toString("base64"),
    size: bytes.byteLength,
  };
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

async function fetchBoundedBytes(
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

function selectImageAttachment(
  attachments: DiscordAttachment[],
  attachmentId: string | undefined,
): DiscordAttachment {
  const attachment = attachmentId
    ? attachments.find((item) => item.id === attachmentId)
    : attachments.find(isImageAttachment);
  if (!attachment) {
    throw new Error(
      attachmentId
        ? `Could not find image attachment ${attachmentId}.`
        : "No image attachment found on that Discord message.",
    );
  }
  if (!isImageAttachment(attachment)) {
    throw new Error(`Attachment ${attachment.id} is not an image.`);
  }
  return attachment;
}

function isImageAttachment(attachment: DiscordAttachment): boolean {
  if (attachment.content_type?.startsWith("image/")) return true;
  const extension = extname(attachment.filename ?? "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
}

function formatDownloadedImage(input: {
  savedPath: string;
  mimeType: string;
  size: number;
}): string {
  return [
    "Downloaded Discord image attachment.",
    `Saved to: ${input.savedPath}`,
    `MIME type: ${input.mimeType}`,
    `Size: ${input.size} bytes`,
  ].join("\n");
}

async function resolveAllowedImagePath(path: string): Promise<string> {
  const raw = path.trim().startsWith("@") ? path.trim().slice(1) : path.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(raw);
  return assertAllowedImagePath(absolute);
}

async function readAllowedImage(
  path: string,
): Promise<{ path: string; data: Buffer }> {
  const canonicalPath = await resolveAllowedImagePath(path);
  const handle = await open(canonicalPath, "r");
  try {
    const openedStat = await handle.stat();
    const currentPath = await resolveAllowedImagePath(canonicalPath);
    const currentStat = await stat(currentPath);
    if (
      openedStat.dev !== currentStat.dev ||
      openedStat.ino !== currentStat.ino
    ) {
      throw new Error("Image changed while it was being authorized.");
    }
    return {
      path: canonicalPath,
      data: await readBoundedHandle(handle, MAX_DISCORD_FILE_BYTES, "Image"),
    };
  } finally {
    await handle.close();
  }
}

async function assertAllowedImagePath(path: string): Promise<string> {
  const absolute = resolve(path);
  const allowed = [
    generatedImagesRoot(),
    discordAttachmentsRoot(),
    assetsRoot(),
  ];
  const canonicalPath = await realpath(absolute);
  const canonicalRoots = await Promise.all(
    allowed.map(async (root) => canonicalAllowedRoot(root)),
  );
  if (
    !canonicalRoots.some(
      (root) => root !== undefined && isPathInside(canonicalPath, root),
    )
  ) {
    throw new Error(
      `Image path must resolve under ${allowed.join(", ")}. Received: ${absolute}`,
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

function isPathInside(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("File byte limit must be a positive integer.");
  }
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
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function channelKindToType(kind: string | undefined): number {
  switch (kind?.trim()) {
    case undefined:
    case "":
    case "text":
      return ChannelType.GuildText;
    case "forum":
      return ChannelType.GuildForum;
    case "voice":
      return ChannelType.GuildVoice;
    case "category":
      return ChannelType.GuildCategory;
    default:
      throw new Error("kind must be text, forum, voice, or category");
  }
}

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function formatChannels(channels: DiscordChannel[]): string {
  return [
    "# Discord channels",
    "",
    ...channels
      .toSorted((left, right) =>
        channelSortKey(left).localeCompare(channelSortKey(right)),
      )
      .map(formatChannel),
  ].join("\n");
}

function channelSortKey(channel: DiscordChannel): string {
  return `${channel.parent_id ?? ""}:${channel.name ?? channel.id}`;
}

function formatChannel(channel: DiscordChannel): string {
  const name = channel.name ?? "[unnamed]";
  const parent = channel.parent_id ? ` parent=${channel.parent_id}` : "";
  const topic = channel.topic ? ` topic=${channel.topic}` : "";
  const thread = channel.thread_metadata
    ? ` archived=${channel.thread_metadata.archived ?? false} locked=${channel.thread_metadata.locked ?? false}`
    : "";
  return `- ${name} (${channel.id}) type=${channel.type}${parent}${topic}${thread}`;
}

function formatMessages(channelId: string, messages: DiscordMessage[]): string {
  return [
    `# Discord history for channel ${channelId}`,
    "",
    ...messages.map(formatMessage),
  ].join("\n");
}

function formatMessage(message: DiscordMessage): string {
  const author =
    message.author.global_name ?? message.author.username ?? message.author.id;
  const content = message.content.trim() || "[no text content]";
  const attachments =
    message.attachments
      ?.map(
        (attachment) =>
          attachment.url ?? attachment.filename ?? attachment.id ?? "",
      )
      .filter(Boolean)
      .join(", ") ?? "";
  const attachmentText = attachments ? ` attachments=${attachments}` : "";
  const edited = message.edited_timestamp
    ? ` edited=${message.edited_timestamp}`
    : "";
  return [
    `- ${message.timestamp}${edited}`,
    `${author} (${message.author.id})`,
    `message=${message.id}`,
    `channel=${message.channel_id}:`,
    content,
    attachmentText,
  ].join(" ");
}

function formatSearchResult(
  result: z.infer<typeof DiscordSearchResultSchema>,
): string {
  if (result.retry_after !== undefined || result.message) {
    return [
      "# Discord message search",
      "",
      result.message ?? "Search index is not ready.",
      result.retry_after === undefined
        ? ""
        : `Retry after ${result.retry_after} seconds.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const messages = result.messages?.flat() ?? [];
  return [
    `# Discord message search (${result.total_results ?? messages.length} matches)`,
    "",
    ...messages.map(formatMessage),
  ].join("\n");
}

function formatThreadList(
  threads: z.infer<typeof DiscordThreadListSchema>,
): string {
  return [
    `# Discord threads (${threads.threads.length})`,
    "",
    ...threads.threads.map(formatChannel),
  ].join("\n");
}

function formatMembers(members: z.infer<typeof DiscordMemberSchema>[]): string {
  return [
    `# Discord members (${members.length})`,
    "",
    ...members.map(formatMember),
  ].join("\n");
}

function formatMember(member: z.infer<typeof DiscordMemberSchema>): string {
  const user = member.user;
  const name = user
    ? `${user.global_name ?? user.username} (${user.id})`
    : "[unknown user]";
  const nick = member.nick ? ` nick=${member.nick}` : "";
  const roles = member.roles?.length ? ` roles=${member.roles.join(",")}` : "";
  const timeout = member.communication_disabled_until
    ? ` timeout_until=${member.communication_disabled_until}`
    : "";
  return `- ${name}${nick}${roles}${timeout}`;
}

function formatRoles(roles: z.infer<typeof DiscordRoleSchema>[]): string {
  return [
    `# Discord roles (${roles.length})`,
    "",
    ...roles
      .toSorted((left, right) => (right.position ?? 0) - (left.position ?? 0))
      .map((role) => {
        const managed = role.managed ? " managed=true" : "";
        const mentionable = role.mentionable ? " mentionable=true" : "";
        return `- ${role.name} (${role.id}) position=${role.position ?? 0}${managed}${mentionable}`;
      }),
  ].join("\n");
}

function formatAuditLog(
  auditLog: z.infer<typeof DiscordAuditLogSchema>,
): string {
  const users = new Map(
    auditLog.users?.map((user) => [
      user.id,
      user.global_name ?? user.username ?? user.id,
    ]) ?? [],
  );
  return [
    `# Discord audit log (${auditLog.audit_log_entries.length})`,
    "",
    ...auditLog.audit_log_entries.map((entry) => {
      const actor = entry.user_id
        ? (users.get(entry.user_id) ?? entry.user_id)
        : "unknown";
      const target = entry.target_id ? ` target=${entry.target_id}` : "";
      const reason = entry.reason ? ` reason=${entry.reason}` : "";
      return `- entry=${entry.id} action=${entry.action_type} actor=${actor}${target}${reason}`;
    }),
  ].join("\n");
}
