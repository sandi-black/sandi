import { type JSX, useEffect, useRef } from "react";

import {
  EMPTY_COMPOSER_DRAFT,
  submitPendingComposer,
} from "./composer-submission";
import { guard } from "./guard";
import { useChatStore } from "./store";

// The message box: autosizing textarea, attach button, staged-attachment
// tray, and a send button that becomes stop while a turn is in flight.

export function Composer({
  onSubmit,
  onStop,
}: {
  onSubmit(text: string, attachmentIds: string[]): Promise<void>;
  onStop(turnId: string): void;
}): JSX.Element {
  const conversationId = useChatStore((state) => state.activeConversationId);
  const draft = useChatStore((state) =>
    conversationId
      ? (state.composers[conversationId] ?? EMPTY_COMPOSER_DRAFT)
      : EMPTY_COMPOSER_DRAFT,
  );
  const submitting = useChatStore((state) =>
    conversationId ? Boolean(state.pendingSubmissions[conversationId]) : false,
  );
  const removeStaged = useChatStore((state) => state.removeStaged);
  const addStaged = useChatStore((state) => state.addStaged);
  const setDraft = useChatStore((state) => state.setDraft);
  const beginSubmission = useChatStore(
    (state) => state.beginComposerSubmission,
  );
  const settleSubmission = useChatStore(
    (state) => state.settleComposerSubmission,
  );
  const queue = useChatStore((state) => state.queue);
  const link = useChatStore((state) => state.link);

  const textarea = useRef<HTMLTextAreaElement>(null);

  // Autosize: grow with content up to the CSS max-height. Runs after every
  // render (no dependency array) because the height reads the DOM, not state;
  // draft changes are what trigger the renders that matter.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  });

  const inflight = queue?.inflightTurnId;
  const canSend = draft.text.trim().length > 0 || draft.staged.length > 0;

  const submit = (): void => {
    if (!conversationId) return;
    const submission = beginSubmission(conversationId);
    if (!submission) return;
    guard(
      submitPendingComposer({
        submission,
        submit: onSubmit,
        settle: (ok) => settleSubmission(conversationId, ok),
      }),
      "could not send the message",
    );
    textarea.current?.focus();
  };

  const pick = async (): Promise<void> => {
    if (!conversationId) return;
    const picked = await window.sandiChat.pickAttachments();
    for (const attachment of picked) addStaged(conversationId, attachment);
  };

  const paste = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> => {
    if (!conversationId) return;
    for (const item of event.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const dataUrl = await fileToDataUrl(file);
        if (!dataUrl) continue;
        const stagedImage = await window.sandiChat.stagePastedImage(dataUrl);
        if (stagedImage) addStaged(conversationId, stagedImage);
      }
    }
  };

  return (
    <div className="composer">
      {draft.staged.length > 0 && (
        <div className="composer-staged">
          {draft.staged.map((attachment) => (
            <span className="attachment-chip" key={attachment.id}>
              <span className="chip-name" title={attachment.path}>
                {attachment.kind === "image" ? "🖼 " : ""}
                {attachment.name}
              </span>
              <button
                type="button"
                title="Remove"
                onClick={() => {
                  if (!conversationId) return;
                  removeStaged(conversationId, attachment.id);
                  guard(
                    window.sandiChat.unstageAttachment(attachment.id),
                    "could not remove the attachment",
                  );
                }}
                disabled={submitting}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textarea}
          rows={1}
          value={draft.text}
          disabled={submitting}
          placeholder={
            link.state === "linked"
              ? "Message Sandi..."
              : "Message Sandi (streaming needs the link)..."
          }
          onChange={(event) => {
            if (conversationId) setDraft(conversationId, event.target.value);
          }}
          onPaste={(event) =>
            guard(paste(event), "could not attach the pasted image")
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !submitting) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="icon-button"
          title="Attach files"
          disabled={submitting || !conversationId}
          onClick={() => guard(pick(), "could not attach files")}
        >
          ✚
        </button>
        {inflight ? (
          <button
            type="button"
            className="send-button stop"
            title="Stop this turn"
            onClick={() => onStop(inflight)}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="send-button"
            title="Send"
            disabled={!canSend || submitting}
            onClick={submit}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
