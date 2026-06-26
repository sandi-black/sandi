import type {
  CanonicalConversationId,
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";

export type ApiConversationRef = {
  identityId: string;
  deviceId: string;
  conversationId: string;
};

// Each routing segment must be losslessly representable: distinct identity,
// device, and conversation handles must never collapse into the same canonical
// or storage id. Restricting the alphabet keeps both the `:`-joined canonical
// id and the `-`-joined storage id (also a path component) unambiguous without
// any encoding, because none of the allowed characters are separators.
const SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

export type ApiSegmentField = "identityId" | "deviceId" | "conversationId";

export class InvalidApiSegmentError extends Error {
  readonly field: ApiSegmentField;

  constructor(field: ApiSegmentField) {
    super(`invalid ${field}`);
    this.name = "InvalidApiSegmentError";
    this.field = field;
  }
}

/**
 * Validates a single routing segment, throwing `InvalidApiSegmentError` when it
 * falls outside the allowed alphabet. Returns the value unchanged so callers can
 * inline it; the value is never rewritten, so no two inputs collide.
 */
export function requireApiSegment(
  value: string,
  field: ApiSegmentField,
): string {
  if (!SEGMENT.test(value)) throw new InvalidApiSegmentError(field);
  return value;
}

/**
 * Validates every routing segment of a ref. Throws `InvalidApiSegmentError` for
 * the first offending field. Callers map this to a 400 response.
 */
export function validateApiConversationRef(ref: ApiConversationRef): void {
  requireApiSegment(ref.identityId, "identityId");
  requireApiSegment(ref.deviceId, "deviceId");
  requireApiSegment(ref.conversationId, "conversationId");
}

export function canonicalApiConversationId(
  input: ApiConversationRef,
): CanonicalConversationId {
  return [
    "api",
    requireApiSegment(input.identityId, "identityId"),
    requireApiSegment(input.deviceId, "deviceId"),
    requireApiSegment(input.conversationId, "conversationId"),
  ].join(":");
}

export function apiConversationStorageId(input: ApiConversationRef): string {
  return [
    "api",
    requireApiSegment(input.identityId, "identityId"),
    requireApiSegment(input.deviceId, "deviceId"),
    requireApiSegment(input.conversationId, "conversationId"),
  ].join("-");
}

export function buildApiConversationManifest(input: {
  identityId: string;
  deviceId: string;
  conversationId: string;
  participant: ConversationParticipant;
  title?: string;
}): ConversationManifest {
  const now = new Date().toISOString();
  return {
    canonicalId: canonicalApiConversationId(input),
    surface: "api",
    platform: input.participant.platform,
    kind: "session",
    title: input.title?.trim() || `API session ${input.conversationId}`,
    createdAt: now,
    updatedAt: now,
    starterParticipantRef: participantRef(input.participant),
    participants: [input.participant],
    memoryScopes: apiSessionMemoryScopes(input.conversationId),
    surfacePrompt: apiSessionSurfacePrompt(input),
    surfaceContext: {
      deviceId: input.deviceId,
      conversationId: input.conversationId,
    },
  };
}

function apiSessionMemoryScopes(
  conversationId: string,
): ConversationMemoryScope[] {
  return [
    {
      label: "API session",
      refPrefix: `surfaces/api/sessions/${requireApiSegment(conversationId, "conversationId")}`,
      area: "current_thread",
    },
  ];
}

function apiSessionSurfacePrompt(input: ApiConversationRef): string {
  return [
    "This is a persistent API session conversation.",
    `Device: ${input.deviceId}`,
    `Session handle: ${input.conversationId}`,
    "Your reply is returned to the caller as plain Markdown in the HTTP response body. There are no platform send side effects in this surface yet, so keep the final assistant text self-contained.",
  ].join("\n");
}
