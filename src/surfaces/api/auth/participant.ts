import type { ConversationParticipant } from "@/lib/conversations/types";
import {
  type HumanIdentityRecord,
  IDENTITY_PLATFORMS,
  PLATFORM_IDENTITY_DESCRIPTORS,
} from "@/lib/identity/types";

/**
 * Resolves a human identity to the configured primary platform account so API
 * turns keep a stable memory arena and account route. Records without an
 * explicit preference retain the established Discord-first fallback.
 */
export function apiParticipantFromHuman(
  human: HumanIdentityRecord,
): ConversationParticipant | undefined {
  const platform =
    human.primaryPlatform ??
    IDENTITY_PLATFORMS.find((candidate) =>
      Boolean(
        PLATFORM_IDENTITY_DESCRIPTORS[candidate].readAccount(human.platforms),
      ),
    );
  if (!platform) return undefined;
  const account = PLATFORM_IDENTITY_DESCRIPTORS[platform].readAccount(
    human.platforms,
  );
  if (!account) return undefined;

  const participant: ConversationParticipant = {
    platform,
    platformUserId: account.id ?? account.username,
    username: account.username,
    identityId: human.id,
    joinedAt: new Date().toISOString(),
  };
  if (human.displayName) participant.displayName = human.displayName;
  return participant;
}
