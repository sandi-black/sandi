import { type JSX, useCallback, useEffect, useState } from "react";

import { Composer } from "./Composer";
import { guard } from "./guard";
import { PairingCard } from "./PairingCard";
import { SessionDrawer } from "./SessionDrawer";
import { StatusBar } from "./StatusBar";
import { useChatStore } from "./store";
import { TranscriptView } from "./TranscriptView";

// The popover's root: header, transcript, queue chips, composer, status bar,
// and the session drawer. Wires the bridge's push events into the store and
// owns the submit/stop/retry flows.

export function ChatApp(): JSX.Element {
  const link = useChatStore((state) => state.link);
  const queue = useChatStore((state) => state.queue);
  const activeConversationId = useChatStore(
    (state) => state.activeConversationId,
  );
  const sessions = useChatStore((state) => state.sessions);
  const showThinking = useChatStore((state) => state.showThinking);
  const [dragOver, setDragOver] = useState(false);

  // The store constant is module-scoped, so these callbacks depend on nothing.
  const selectSession = useCallback(
    async (conversationId: string): Promise<void> => {
      const transcript = await window.sandiChat.selectSession(conversationId);
      useChatStore.getState().setActive(conversationId, transcript);
    },
    [],
  );

  const refreshSessions = useCallback(async (): Promise<void> => {
    useChatStore.getState().setSessions(await window.sandiChat.listSessions());
  }, []);

  // Boot: load sessions, open the most recent one (or start fresh), fetch
  // the link state, and subscribe to every push channel.
  useEffect(() => {
    const chat = window.sandiChat;
    guard(
      (async () => {
        const sessionList = await chat.listSessions();
        useChatStore.getState().setSessions(sessionList);
        const recent = sessionList[0];
        if (recent) {
          await selectSession(recent.conversationId);
        } else {
          const created = await chat.createSession();
          useChatStore.getState().setSessions(await chat.listSessions());
          useChatStore.getState().setActive(created.conversationId, []);
        }
        useChatStore.getState().setLink(await chat.getLinkStatus());
      })(),
      "could not load sessions",
    );

    const unsubscribers = [
      chat.onLinkStatus((status) => useChatStore.getState().setLink(status)),
      chat.onTurnDelta((event) => {
        const state = useChatStore.getState();
        // A delta for a turn we are not yet rendering live means the queue
        // just promoted it; begin its live view.
        if (state.liveTurn?.turnId !== event.turnId) {
          const conversationId = state.activeConversationId;
          if (conversationId === undefined) return;
          state.beginLiveTurn(event.turnId, conversationId);
        }
        useChatStore
          .getState()
          .appendDelta(event.turnId, event.channel, event.delta);
      }),
      chat.onTurnAttachment((event) => {
        const state = useChatStore.getState();
        if (state.liveTurn?.turnId !== event.turnId) {
          const conversationId = state.activeConversationId;
          if (conversationId === undefined) return;
          state.beginLiveTurn(event.turnId, conversationId);
        }
        useChatStore
          .getState()
          .appendLiveAttachment(event.turnId, event.attachment);
      }),
      chat.onTurnSettled((event) => {
        const state = useChatStore.getState();
        state.endLiveTurn(event.turnId);
        if (event.conversationId !== state.activeConversationId) return;
        if (event.ok) {
          state.appendTranscript({
            type: "assistant",
            turnId: event.turnId,
            ts: new Date().toISOString(),
            text: event.text ?? "",
          });
          // Reload from disk so thinking and attachments (persisted by main)
          // appear without duplicating that assembly logic here.
          guard(
            selectSession(event.conversationId),
            "could not reload the conversation",
          );
        } else {
          state.appendTranscript({
            type: "error",
            turnId: event.turnId,
            ts: new Date().toISOString(),
            text: event.error ?? "turn failed",
          });
        }
        guard(refreshSessions(), "could not refresh the session list");
      }),
      chat.onQueueState((queueState) => {
        if (
          queueState.conversationId ===
          useChatStore.getState().activeConversationId
        ) {
          useChatStore.getState().setQueue(queueState);
        }
      }),
      chat.onSessionsChanged(() =>
        guard(refreshSessions(), "could not refresh the session list"),
      ),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [selectSession, refreshSessions]);

  const submit = useCallback((text: string, attachmentIds: string[]): void => {
    const conversationId = useChatStore.getState().activeConversationId;
    if (!conversationId) return;
    // Optimistic append; main writes the same entry to disk.
    guard(
      window.sandiChat
        .submitTurn({ conversationId, text, attachmentIds })
        .then(({ turnId }) => {
          useChatStore.getState().appendTranscript({
            type: "user",
            turnId,
            ts: new Date().toISOString(),
            text,
          });
        }),
      "could not send the message",
    );
  }, []);

  const activeTitle =
    sessions.find((session) => session.conversationId === activeConversationId)
      ?.title ?? "Sandi";

  // Window-level drag-drop: anything with a path becomes a staged attachment.
  const handleDrop = useCallback((event: React.DragEvent): void => {
    event.preventDefault();
    setDragOver(false);
    for (const file of event.dataTransfer.files) {
      guard(
        window.sandiChat.stageDroppedFile(file).then((staged) => {
          if (staged) useChatStore.getState().addStaged(staged);
        }),
        `could not attach ${file.name}`,
      );
    }
  }, []);

  return (
    // The root container is a drag-drop target, not a click control; keyboard
    // users attach via the composer's attach button instead.
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target only
    <div
      className={`popover${dragOver ? " drag-over" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.target === event.currentTarget) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <header className="header">
        <button
          type="button"
          className="icon-button"
          title="Conversations"
          onClick={() => useChatStore.getState().setDrawerOpen(true)}
        >
          ☰
        </button>
        <span className="header-title">{activeTitle}</span>
        <button
          type="button"
          className={`icon-button${showThinking ? " active" : ""}`}
          title="Show Sandi's thinking"
          onClick={() => useChatStore.getState().setShowThinking(!showThinking)}
        >
          ✦
        </button>
        <button
          type="button"
          className="icon-button"
          title="Close"
          onClick={() => window.sandiChat.closeWindow()}
        >
          ✕
        </button>
      </header>

      {link.state === "unpaired" ? (
        <PairingCard
          onPaired={() => {
            guard(
              window.sandiChat
                .getLinkStatus()
                .then((status) => useChatStore.getState().setLink(status)),
              "could not read the link status",
            );
          }}
        />
      ) : (
        <>
          <TranscriptView onRetry={(text) => submit(text, [])} />
          {queue && queue.pending.length > 0 && (
            <div className="queue-strip">
              {queue.pending.map((turn) => (
                <span className="queue-chip" key={turn.turnId}>
                  <span className="chip-name">{turn.text}</span>
                  <button
                    type="button"
                    title="Remove from queue"
                    onClick={() =>
                      guard(
                        window.sandiChat.cancelQueued(turn.turnId),
                        "could not remove the queued message",
                      )
                    }
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <Composer
            onSubmit={submit}
            onStop={(turnId) =>
              guard(
                window.sandiChat.stopTurn(turnId),
                "could not stop the turn",
              )
            }
          />
        </>
      )}

      <StatusBar />

      <SessionDrawer
        onSelect={(conversationId) =>
          guard(
            selectSession(conversationId),
            "could not open the conversation",
          )
        }
        onCreate={() =>
          guard(
            (async () => {
              const session = await window.sandiChat.createSession();
              await refreshSessions();
              useChatStore.getState().setActive(session.conversationId, []);
            })(),
            "could not create a conversation",
          )
        }
        onDelete={(conversationId) =>
          guard(
            (async () => {
              await window.sandiChat.deleteSession(conversationId);
              await refreshSessions();
              if (
                conversationId !== useChatStore.getState().activeConversationId
              ) {
                return;
              }
              // The active conversation is gone; land on the most recent
              // survivor, or a fresh one if none remain.
              const list = await window.sandiChat.listSessions();
              const next = list[0];
              if (next) {
                await selectSession(next.conversationId);
                return;
              }
              const session = await window.sandiChat.createSession();
              await refreshSessions();
              useChatStore.getState().setActive(session.conversationId, []);
            })(),
            "could not delete the conversation",
          )
        }
      />
    </div>
  );
}
