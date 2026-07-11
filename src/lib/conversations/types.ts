import type { IdentityPlatform } from "@/lib/identity/types";

export type PlatformId = IdentityPlatform;
export type SurfaceId = string;
export type CanonicalConversationId = string;

export type ConversationParticipant = {
  platform: PlatformId;
  platformUserId: string;
  username: string;
  displayName?: string;
  identityId?: string;
  joinedAt: string;
};

export type ConversationMemoryScope = {
  label: string;
  refPrefix: string;
  area?: string | undefined;
};

export type ConversationManifest = {
  canonicalId: CanonicalConversationId;
  surface: SurfaceId;
  platform: PlatformId;
  kind: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  starterParticipantRef: string;
  participants: ConversationParticipant[];
  memoryScopes: ConversationMemoryScope[];
  attachmentHashes?: string[] | undefined;
  surfacePrompt?: string | undefined;
  surfaceContext?: Record<string, unknown> | undefined;
};

export type TurnContext = {
  conversation: ConversationManifest;
  author: ConversationParticipant;
  messageId: string;
  input: string;
};

export function participantRef(participant: ConversationParticipant): string {
  return `${participant.platform}:${participant.platformUserId}`;
}

export function participantLabel(participant: ConversationParticipant): string {
  const identity = participant.identityId
    ? `, identity ${participant.identityId}`
    : "";
  return `${participant.username} (${participantRef(participant)}${identity})`;
}
