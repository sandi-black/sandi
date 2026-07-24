import { isRecord } from "@/lib/type-guards";
import type { ReminderMessageRef } from "@/surfaces/discord/reminders/schemas";
import { updateReminderManaged } from "@/surfaces/discord/reminders/store";

const UNKNOWN_MESSAGE_ERROR_CODE = 10_008;

export function isUnknownDiscordMessageError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error["code"] === UNKNOWN_MESSAGE_ERROR_CODE;
}

export async function pruneReminderMessageRefs(
  root: string,
  id: string,
  staleRefs: readonly ReminderMessageRef[],
): Promise<void> {
  if (staleRefs.length === 0) return;
  const staleKeys = new Set(staleRefs.map(messageRefKey));
  await updateReminderManaged(root, id, (current) => {
    const messageRefs = current.messageRefs.filter(
      (ref) => !staleKeys.has(messageRefKey(ref)),
    );
    if (messageRefs.length === current.messageRefs.length) return current;
    return { ...current, messageRefs };
  });
}

function messageRefKey(ref: ReminderMessageRef): string {
  return `${ref.channelId}:${ref.messageId}`;
}
