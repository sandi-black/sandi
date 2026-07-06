import avatarUrl from "@assets/sandi-mirrored-small.png";
import type { TranscriptEntry } from "@shared/ipc-contract";
import { type JSX, useEffect, useRef } from "react";

import { AttachmentList } from "./AttachmentList";
import { MarkdownMessage } from "./MarkdownMessage";
import { useChatStore } from "./store";

// The conversation: persisted entries plus the live streaming turn. Follows
// the bottom while new content arrives unless the human has scrolled up to
// read something.

export function TranscriptView({
  onRetry,
}: {
  onRetry(text: string): void;
}): JSX.Element {
  const transcript = useChatStore((state) => state.transcript);
  const liveTurn = useChatStore((state) => state.liveTurn);
  const liveAttachments = useChatStore((state) => state.liveAttachments);
  const queue = useChatStore((state) => state.queue);
  const showThinking = useChatStore((state) => state.showThinking);

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  const handleScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distance < 48;
  };

  const waiting = queue?.inflightTurnId !== undefined && liveTurn === undefined;

  return (
    <div className="transcript" ref={scroller} onScroll={handleScroll}>
      {transcript.length === 0 && liveTurn === undefined && !waiting && (
        <p className="empty-note">
          Ask Sandi anything.
          <br />
          She can read, write, and run things on this machine.
        </p>
      )}
      {transcript.map((entry) => (
        <TranscriptRow
          entry={entry}
          key={`${entry.turnId}-${entry.type}-${entry.ts}`}
          onRetry={onRetry}
          showThinking={showThinking}
          transcript={transcript}
        />
      ))}
      {(liveTurn || waiting) && (
        <div className="msg-sandi">
          <img src={avatarUrl} alt="" className="avatar" />
          <div className="msg-sandi-body">
            {showThinking && liveTurn && liveTurn.thinking.length > 0 && (
              <div className="thinking">{liveTurn.thinking}</div>
            )}
            {liveTurn && liveTurn.text.length > 0 ? (
              <MarkdownMessage text={liveTurn.text} />
            ) : null}
            <AttachmentList attachments={liveAttachments} />
            <span className="cursor">▍</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptRow({
  entry,
  transcript,
  showThinking,
  onRetry,
}: {
  entry: TranscriptEntry;
  transcript: TranscriptEntry[];
  showThinking: boolean;
  onRetry(text: string): void;
}): JSX.Element {
  if (entry.type === "user") {
    return (
      <div className="msg-user">
        {entry.text}
        {entry.attachments && entry.attachments.length > 0 && (
          <div className="attachment-row">
            {entry.attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.path}>
                <span className="chip-name" title={attachment.path}>
                  {attachment.name}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (entry.type === "error") {
    // Retry resubmits the user text that produced this failure.
    const source = transcript.find(
      (candidate) =>
        candidate.turnId === entry.turnId && candidate.type === "user",
    );
    return (
      <div className="msg-error">
        <span>{entry.text}</span>
        {source?.type === "user" && (
          <button
            type="button"
            className="retry-button"
            onClick={() => onRetry(source.text)}
          >
            retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="msg-sandi">
      <img src={avatarUrl} alt="" className="avatar" />
      <div className="msg-sandi-body">
        {showThinking && entry.thinking && entry.thinking.length > 0 && (
          <details className="thinking">
            <summary className="thinking-summary">thoughts</summary>
            {entry.thinking}
          </details>
        )}
        <MarkdownMessage text={entry.text} />
        <AttachmentList attachments={entry.attachments ?? []} />
      </div>
    </div>
  );
}
