import type { SessionDeleteOutcome } from "@shared/ipc-contract";

export async function deleteSessionIfIdle(input: {
  conversationId: string;
  hasWork(conversationId: string): boolean;
  deleteSession(conversationId: string): Promise<void>;
  onDeleted(): void;
}): Promise<SessionDeleteOutcome> {
  if (input.hasWork(input.conversationId)) {
    return { ok: false, reason: "busy" };
  }
  await input.deleteSession(input.conversationId);
  input.onDeleted();
  return { ok: true };
}
