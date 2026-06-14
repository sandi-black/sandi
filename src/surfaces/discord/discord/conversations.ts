import type {
  CanonicalConversationId,
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";

export type DiscordThreadConversationSource =
  | {
      kind: "forum";
    }
  | {
      kind: "channel_branch";
      parentConversationId: CanonicalConversationId;
      originChannelId: string;
      originMessageId: string;
      originMessageUrl: string;
      starterMessage: string;
      bridgeSummary: string;
      createdByUserId: string;
    }
  | {
      kind: "message_thread";
      originChannelId: string;
      originMessageId: string;
      originMessageUrl: string;
      starterMessage: string;
      createdByUserId: string;
    };

export function canonicalDiscordThreadId(
  guildId: string,
  channelId: string,
  threadId: string,
): CanonicalConversationId {
  return `discord:${guildId}:${channelId}:${threadId}`;
}

export function canonicalDiscordChannelId(
  guildId: string,
  channelId: string,
): CanonicalConversationId {
  return `discord:${guildId}:${channelId}:room`;
}

export function buildDiscordThreadManifest(input: {
  guildId: string;
  channelId: string;
  threadId: string;
  title: string;
  starter: ConversationParticipant;
  source?: DiscordThreadConversationSource;
}): ConversationManifest {
  const now = new Date().toISOString();
  const surfaceContext: Record<string, unknown> = {
    guildId: input.guildId,
    channelId: input.channelId,
    threadId: input.threadId,
  };
  if (input.source) surfaceContext["source"] = input.source;
  return {
    canonicalId: canonicalDiscordThreadId(
      input.guildId,
      input.channelId,
      input.threadId,
    ),
    surface: "discord",
    platform: "discord",
    kind: "thread",
    title: input.title,
    createdAt: now,
    updatedAt: now,
    starterParticipantRef: participantRef(input.starter),
    participants: [input.starter],
    memoryScopes: discordThreadMemoryScopes(input),
    surfacePrompt: discordThreadSurfacePrompt(input.source),
    surfaceContext,
  };
}

export function buildDiscordChannelManifest(input: {
  guildId: string;
  channelId: string;
  title: string;
  starter: ConversationParticipant;
}): ConversationManifest {
  const now = new Date().toISOString();
  return {
    canonicalId: canonicalDiscordChannelId(input.guildId, input.channelId),
    surface: "discord",
    platform: "discord",
    kind: "channel",
    title: input.title,
    createdAt: now,
    updatedAt: now,
    starterParticipantRef: participantRef(input.starter),
    participants: [input.starter],
    memoryScopes: [
      {
        label: "Current Channel Room",
        refPrefix: discordChannelMemoryRef(input.channelId),
        area: "current_channel",
      },
    ],
    surfaceContext: {
      guildId: input.guildId,
      channelId: input.channelId,
    },
  };
}

export function discordConversationStorageId(
  conversation: ConversationManifest,
): string {
  const context = conversation.surfaceContext;
  if (!context) {
    throw new Error(
      `Discord conversation ${conversation.canonicalId} is missing surface context.`,
    );
  }
  const threadId = stringField(context, "threadId");
  if (conversation.kind === "thread" && threadId) return threadId;
  const channelId = stringField(context, "channelId");
  if (channelId) return channelId;
  throw new Error(
    `Discord conversation ${conversation.canonicalId} is missing a storage id.`,
  );
}

export function isDiscordThreadConversation(
  conversation: ConversationManifest | undefined,
): boolean {
  return conversation?.surface === "discord" && conversation.kind === "thread";
}

export function withDiscordSurfacePrompt(
  conversation: ConversationManifest,
): ConversationManifest {
  if (conversation.surfacePrompt?.trim()) return conversation;
  const source = discordThreadSourceFromManifest(conversation);
  if (!source) return conversation;
  const surfacePrompt = discordThreadSurfacePrompt(source);
  if (!surfacePrompt) return conversation;
  return { ...conversation, surfacePrompt };
}

function discordThreadMemoryScopes(input: {
  threadId: string;
  source?: DiscordThreadConversationSource;
}): ConversationMemoryScope[] {
  const scopes: ConversationMemoryScope[] = [
    {
      label: "Current Thread Archive",
      refPrefix: discordThreadMemoryRef(input.threadId),
      area: "current_thread",
    },
  ];
  if (input.source?.kind === "channel_branch") {
    scopes.push({
      label: "Parent Channel Room",
      refPrefix: discordChannelMemoryRef(input.source.originChannelId),
      area: "parent_channel",
    });
  }
  return scopes;
}

function discordThreadMemoryRef(threadId: string): string {
  return `surfaces/discord/threads/${threadId}`;
}

function discordChannelMemoryRef(channelId: string): string {
  return `surfaces/discord/channels/${channelId}`;
}

function discordThreadSurfacePrompt(
  source: DiscordThreadConversationSource | undefined,
): string | undefined {
  if (source?.kind === "message_thread") {
    return [
      "This is a Sandi-managed Discord thread created from a top-level channel mention.",
      `Thread origin message: ${source.originMessageUrl}`,
      "Treat the origin message as the first user prompt in this thread conversation.",
      "This thread is the whole Pi session. Do not assume unrelated parent-channel chatter is part of this conversation.",
      "Other top-level parent-channel messages become separate Sandi thread conversations unless explicitly brought in.",
    ].join("\n");
  }
  if (source?.kind === "channel_branch") {
    return [
      "This is a Sandi-managed Discord thread branched from a standard channel.",
      `Parent channel conversation ID: ${source.parentConversationId}`,
      `Thread origin message: ${source.originMessageUrl}`,
      `Branch context: ${source.bridgeSummary}`,
      "Parent channel context is available by pointer; do not assume unrelated parent-channel chatter is part of this scoped thread.",
    ].join("\n");
  }
  return undefined;
}

function discordThreadSourceFromManifest(
  conversation: ConversationManifest,
): DiscordThreadConversationSource | undefined {
  if (conversation.surface !== "discord" || conversation.kind !== "thread") {
    return undefined;
  }
  const source = conversation.surfaceContext?.["source"];
  if (!isRecord(source)) return undefined;
  if (source["kind"] === "forum") return { kind: "forum" };
  if (source["kind"] === "message_thread") {
    const originChannelId = stringField(source, "originChannelId");
    const originMessageId = stringField(source, "originMessageId");
    const originMessageUrl = stringField(source, "originMessageUrl");
    const starterMessage = stringField(source, "starterMessage");
    const createdByUserId = stringField(source, "createdByUserId");
    if (
      !originChannelId ||
      !originMessageId ||
      !originMessageUrl ||
      !starterMessage ||
      !createdByUserId
    ) {
      return undefined;
    }
    return {
      kind: "message_thread",
      originChannelId,
      originMessageId,
      originMessageUrl,
      starterMessage,
      createdByUserId,
    };
  }
  if (source["kind"] !== "channel_branch") return undefined;
  const parentConversationId = stringField(source, "parentConversationId");
  const originChannelId = stringField(source, "originChannelId");
  const originMessageId = stringField(source, "originMessageId");
  const originMessageUrl = stringField(source, "originMessageUrl");
  const starterMessage = stringField(source, "starterMessage");
  const bridgeSummary = stringField(source, "bridgeSummary");
  const createdByUserId = stringField(source, "createdByUserId");
  if (
    !parentConversationId ||
    !originChannelId ||
    !originMessageId ||
    !originMessageUrl ||
    !starterMessage ||
    !bridgeSummary ||
    !createdByUserId
  ) {
    return undefined;
  }
  return {
    kind: "channel_branch",
    parentConversationId,
    originChannelId,
    originMessageId,
    originMessageUrl,
    starterMessage,
    bridgeSummary,
    createdByUserId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
