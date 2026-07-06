import { type JSX, useEffect, useRef, useState } from "react";

import { useChatStore } from "./store";

// The message box: autosizing textarea, attach button, staged-attachment
// tray, and a send button that becomes stop while a turn is in flight.

export function Composer({
  onSubmit,
  onStop,
}: {
  onSubmit(text: string, attachmentIds: string[]): void;
  onStop(turnId: string): void;
}): JSX.Element {
  const staged = useChatStore((state) => state.staged);
  const removeStaged = useChatStore((state) => state.removeStaged);
  const addStaged = useChatStore((state) => state.addStaged);
  const setStaged = useChatStore((state) => state.setStaged);
  const queue = useChatStore((state) => state.queue);
  const link = useChatStore((state) => state.link);

  const [draft, setDraft] = useState("");
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
  const canSend = draft.trim().length > 0 || staged.length > 0;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 && staged.length === 0) return;
    onSubmit(
      text.length > 0 ? text : "(see attachments)",
      staged.map((attachment) => attachment.id),
    );
    setDraft("");
    setStaged([]);
    textarea.current?.focus();
  };

  const pick = async (): Promise<void> => {
    const picked = await window.sandiChat.pickAttachments();
    for (const attachment of picked) addStaged(attachment);
  };

  const paste = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> => {
    for (const item of event.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const dataUrl = await fileToDataUrl(file);
        if (!dataUrl) continue;
        const stagedImage = await window.sandiChat.stagePastedImage(dataUrl);
        if (stagedImage) addStaged(stagedImage);
      }
    }
  };

  return (
    <div className="composer">
      {staged.length > 0 && (
        <div className="composer-staged">
          {staged.map((attachment) => (
            <span className="attachment-chip" key={attachment.id}>
              <span className="chip-name" title={attachment.path}>
                {attachment.kind === "image" ? "🖼 " : ""}
                {attachment.name}
              </span>
              <button
                type="button"
                title="Remove"
                onClick={() => {
                  removeStaged(attachment.id);
                  void window.sandiChat.unstageAttachment(attachment.id);
                }}
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
          value={draft}
          placeholder={
            link.state === "linked"
              ? "Message Sandi..."
              : "Message Sandi (streaming needs the link)..."
          }
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => void paste(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="icon-button"
          title="Attach files"
          onClick={() => void pick()}
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
            disabled={!canSend}
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
