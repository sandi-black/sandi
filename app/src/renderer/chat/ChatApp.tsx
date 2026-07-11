import { type JSX, useCallback, useEffect, useRef, useState } from "react";

import { Composer } from "./Composer";
import { guard } from "./guard";
import { PairingCard } from "./PairingCard";
import { ResizeGrips } from "./ResizeGrips";
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
  const [dragOver, setDragOver] = useState(false);
  const selectionGeneration = useRef(0);
  const selectionTarget = useRef<string | undefined>(undefined);

  // A transcript and queue are fetched independently. Only the newest click
  // may commit them, or a slow response for an older session can snap the UI
  // back after the human has already selected another conversation.
  const selectSession = useCallback(
    async (conversationId: string): Promise<void> => {
      const generation = ++selectionGeneration.current;
      selectionTarget.current = conversationId;
      let transcript: Awaited<
        ReturnType<typeof window.sandiChat.selectSession>
      >;
      let queue: Awaited<ReturnType<typeof window.sandiChat.getQueueState>>;
      try {
        transcript = await window.sandiChat.selectSession(conversationId);
        if (generation !== selectionGeneration.current) return;
        // Read queue state last. Any transition after this response is also a
        // push event, while reading it in parallel with a slower transcript
        // could commit an old snapshot after that push had been ignored for
        // the not-yet-active conversation.
        queue = await window.sandiChat.getQueueState(conversationId);
      } catch (error) {
        if (generation === selectionGeneration.current) {
          selectionTarget.current =
            useChatStore.getState().activeConversationId;
        }
        throw error;
      }
      if (generation !== selectionGeneration.current) return;
      useChatStore.getState().setActive(conversationId, transcript, queue);
    },
    [],
  );

  const activateNewSession = useCallback((conversationId: string): void => {
    selectionGeneration.current++;
    selectionTarget.current = conversationId;
    useChatStore.getState().setActive(conversationId, [], {
      conversationId,
      pending: [],
    });
  }, []);

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
          activateNewSession(created.conversationId);
        }
        useChatStore.getState().setLink(await chat.getLinkStatus());
      })(),
      "could not load sessions",
    );

    const unsubscribers = [
      chat.onLinkStatus((status) => useChatStore.getState().setLink(status)),
      chat.onTurnDelta((event) => {
        const state = useChatStore.getState();
        if (
          event.conversationId !== state.activeConversationId ||
          event.conversationId !== selectionTarget.current
        ) {
          return;
        }
        // A delta for a turn we are not yet rendering live means the queue
        // just promoted it; begin its live view.
        if (state.liveTurn?.turnId !== event.turnId) {
          state.beginLiveTurn(event.turnId, event.conversationId);
        }
        useChatStore
          .getState()
          .appendDelta(
            event.turnId,
            event.conversationId,
            event.channel,
            event.delta,
          );
      }),
      chat.onTurnAttachment((event) => {
        const state = useChatStore.getState();
        if (
          event.conversationId !== state.activeConversationId ||
          event.conversationId !== selectionTarget.current
        ) {
          return;
        }
        if (state.liveTurn?.turnId !== event.turnId) {
          state.beginLiveTurn(event.turnId, event.conversationId);
        }
        useChatStore
          .getState()
          .appendLiveAttachment(
            event.turnId,
            event.conversationId,
            event.attachment,
          );
      }),
      chat.onTurnSettled((event) => {
        const state = useChatStore.getState();
        state.endLiveTurn(event.turnId, event.conversationId);
        guard(refreshSessions(), "could not refresh the session list");
        if (
          event.conversationId !== state.activeConversationId ||
          event.conversationId !== selectionTarget.current
        ) {
          return;
        }
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
  }, [activateNewSession, selectSession, refreshSessions]);

  const submit = useCallback(
    async (text: string, attachmentIds: string[]): Promise<void> => {
      const conversationId = useChatStore.getState().activeConversationId;
      if (!conversationId || selectionTarget.current !== conversationId) {
        throw new Error("the conversation changed before submission");
      }
      // Main acknowledges only after the user entry is durable and queued.
      const { turnId } = await window.sandiChat.submitTurn({
        conversationId,
        text,
        attachmentIds,
      });
      const state = useChatStore.getState();
      if (
        state.activeConversationId !== conversationId ||
        selectionTarget.current !== conversationId
      ) {
        return;
      }
      state.appendTranscript({
        type: "user",
        turnId,
        ts: new Date().toISOString(),
        text,
      });
    },
    [],
  );

  // Stable so the transcript rows' memo is not defeated by a fresh retry
  // handler on every streaming render.
  const retry = useCallback(
    (text: string): void =>
      guard(submit(text, []), "could not resend the message"),
    [submit],
  );

  const activeTitle =
    sessions.find((session) => session.conversationId === activeConversationId)
      ?.title ?? "Sandi";

  // Window-level drag-drop: anything with a path becomes a staged attachment.
  const handleDrop = useCallback((event: React.DragEvent): void => {
    event.preventDefault();
    setDragOver(false);
    const state = useChatStore.getState();
    const conversationId = state.activeConversationId;
    if (!conversationId || state.pendingSubmissions[conversationId]) return;
    for (const file of event.dataTransfer.files) {
      guard(
        window.sandiChat.stageDroppedFile(file).then((staged) => {
          if (staged) {
            useChatStore.getState().addStaged(conversationId, staged);
          }
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
          <TranscriptView onRetry={retry} />
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
              const generation = ++selectionGeneration.current;
              selectionTarget.current = undefined;
              let session: Awaited<
                ReturnType<typeof window.sandiChat.createSession>
              >;
              try {
                session = await window.sandiChat.createSession();
                await refreshSessions();
              } catch (error) {
                if (generation === selectionGeneration.current) {
                  selectionTarget.current =
                    useChatStore.getState().activeConversationId;
                }
                throw error;
              }
              if (generation !== selectionGeneration.current) return;
              activateNewSession(session.conversationId);
            })(),
            "could not create a conversation",
          )
        }
        onDelete={(conversationId) =>
          guard(
            (async () => {
              const deletingActive = conversationId === selectionTarget.current;
              const generation = deletingActive
                ? ++selectionGeneration.current
                : selectionGeneration.current;
              if (deletingActive) selectionTarget.current = undefined;
              try {
                const outcome =
                  await window.sandiChat.deleteSession(conversationId);
                if (!outcome.ok) {
                  if (
                    deletingActive &&
                    generation === selectionGeneration.current
                  ) {
                    selectionTarget.current = conversationId;
                  }
                  useChatStore
                    .getState()
                    .setUiError(
                      "Finish or cancel this conversation's active and queued messages before deleting it.",
                    );
                  return;
                }
                useChatStore.getState().discardComposer(conversationId);
                await refreshSessions();
              } catch (error) {
                if (
                  deletingActive &&
                  generation === selectionGeneration.current
                ) {
                  selectionTarget.current =
                    useChatStore.getState().activeConversationId;
                }
                throw error;
              }
              if (
                !deletingActive ||
                generation !== selectionGeneration.current
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
              activateNewSession(session.conversationId);
            })(),
            "could not delete the conversation",
          )
        }
      />

      <ResizeGrips />
    </div>
  );
}
