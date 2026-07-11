import type { StagedAttachment } from "@shared/ipc-contract";

export type ComposerDraft = {
  text: string;
  staged: StagedAttachment[];
};

export type PendingComposerSubmission = ComposerDraft & {
  conversationId: string;
  sentText: string;
};

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", staged: [] };

export function pendingSubmission(
  conversationId: string,
  draft: ComposerDraft,
): PendingComposerSubmission | undefined {
  const sentText = draft.text.trim();
  if (sentText.length === 0 && draft.staged.length === 0) return undefined;
  return {
    conversationId,
    text: draft.text,
    sentText: sentText.length > 0 ? sentText : "(see attachments)",
    staged: [...draft.staged],
  };
}

export async function submitPendingComposer(input: {
  submission: PendingComposerSubmission;
  submit(text: string, attachmentIds: string[]): Promise<void>;
  settle(ok: boolean): void;
}): Promise<void> {
  try {
    await input.submit(
      input.submission.sentText,
      input.submission.staged.map((attachment) => attachment.id),
    );
    input.settle(true);
  } catch (error) {
    input.settle(false);
    throw error;
  }
}
