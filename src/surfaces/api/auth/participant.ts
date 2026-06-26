import type { ConversationParticipant } from "@/lib/conversations/types";
import type { HumanIdentityRecord } from "@/lib/identity/types";

/**
 * Resolves a human identity to the API participant, reusing the human's primary
 * platform account (Discord first, else GitHub) so an API turn shares that
 * human's existing memory arena and account routing. Returns undefined when the
 * human has no usable platform mapping, so callers can reject it.
 */
export function apiParticipantFromHuman(
  human: HumanIdentityRecord,
): ConversationParticipant | undefined {
  const discord = human.platforms.discord;
  if (discord) {
    const participant: ConversationParticipant = {
      platform: "discord",
      platformUserId: discord.id ?? discord.username,
      username: discord.username,
      identityId: human.id,
      joinedAt: new Date().toISOString(),
    };
    if (human.displayName) participant.displayName = human.displayName;
    return participant;
  }
  const github = human.platforms.github;
  if (github) {
    const participant: ConversationParticipant = {
      platform: "github",
      platformUserId: github.id ?? github.login,
      username: github.login,
      identityId: human.id,
      joinedAt: new Date().toISOString(),
    };
    if (human.displayName) participant.displayName = human.displayName;
    return participant;
  }
  return undefined;
}
