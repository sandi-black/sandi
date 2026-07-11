import type {
  LinkStatus,
  QueueState,
  ReplyAttachment,
  SessionSummary,
  StagedAttachment,
  TranscriptEntry,
} from "@shared/ipc-contract";
import { create } from "zustand";

// Renderer state for the chat window. Main is the source of truth; this store
// mirrors it for rendering plus purely local UI state (drawer open, composer
// draft, live streaming buffers). Main forwards only accepted, ordered deltas
// (its response buffer dedupes), so accumulation here is a plain append.

export type LiveTurn = {
  turnId: string;
  conversationId: string;
  text: string;
};

type ChatState = {
  sessions: SessionSummary[];
  activeConversationId: string | undefined;
  transcript: TranscriptEntry[];
  liveTurn: LiveTurn | undefined;
  liveAttachments: ReplyAttachment[];
  queue: QueueState | undefined;
  link: LinkStatus;
  staged: StagedAttachment[];
  drawerOpen: boolean;
  // The most recent failed bridge call, surfaced as a dismissible strip; every
  // fire-and-forget IPC promise routes its rejection here (see guard.ts).
  uiError: string | undefined;

  setSessions(sessions: SessionSummary[]): void;
  setActive(
    conversationId: string,
    transcript: TranscriptEntry[],
    queue: QueueState,
  ): void;
  appendTranscript(entry: TranscriptEntry): void;
  beginLiveTurn(turnId: string, conversationId: string): void;
  appendDelta(
    turnId: string,
    conversationId: string,
    channel: "text" | "thinking",
    delta: string,
  ): void;
  appendLiveAttachment(
    turnId: string,
    conversationId: string,
    attachment: ReplyAttachment,
  ): void;
  endLiveTurn(turnId: string, conversationId: string): void;
  setQueue(queue: QueueState): void;
  setLink(link: LinkStatus): void;
  setStaged(staged: StagedAttachment[]): void;
  addStaged(attachment: StagedAttachment): void;
  removeStaged(id: string): void;
  setDrawerOpen(open: boolean): void;
  setUiError(message: string | undefined): void;
};

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeConversationId: undefined,
  transcript: [],
  liveTurn: undefined,
  liveAttachments: [],
  queue: undefined,
  link: { state: "connecting" },
  staged: [],
  drawerOpen: false,
  uiError: undefined,

  setSessions: (sessions) => set({ sessions }),
  setActive: (conversationId, transcript, queue) =>
    set((state) => {
      const sameConversation = state.activeConversationId === conversationId;
      return {
        activeConversationId: conversationId,
        // A settle-triggered disk reload can finish after the next queued turn
        // has started. Keep newer optimistic entries and live state while the
        // authoritative entries replace matching provisional ones.
        transcript: sameConversation
          ? mergeTranscript(transcript, state.transcript)
          : transcript,
        liveTurn: sameConversation ? state.liveTurn : undefined,
        liveAttachments: sameConversation ? state.liveAttachments : [],
        queue:
          sameConversation && state.queue?.conversationId === conversationId
            ? state.queue
            : queue,
        drawerOpen: false,
      };
    }),
  appendTranscript: (entry) =>
    set((state) => ({ transcript: [...state.transcript, entry] })),
  beginLiveTurn: (turnId, conversationId) =>
    set((state) =>
      state.activeConversationId === conversationId
        ? {
            liveTurn: { turnId, conversationId, text: "" },
            liveAttachments: [],
          }
        : state,
    ),
  appendDelta: (turnId, conversationId, channel, delta) =>
    set((state) => {
      if (
        state.activeConversationId !== conversationId ||
        state.liveTurn?.turnId !== turnId ||
        state.liveTurn.conversationId !== conversationId
      ) {
        return state;
      }
      // Thinking deltas are still streamed by main but no longer rendered.
      if (channel === "thinking") return state;
      return {
        liveTurn: { ...state.liveTurn, text: state.liveTurn.text + delta },
      };
    }),
  appendLiveAttachment: (turnId, conversationId, attachment) =>
    set((state) => {
      if (
        state.activeConversationId !== conversationId ||
        state.liveTurn?.turnId !== turnId ||
        state.liveTurn.conversationId !== conversationId
      ) {
        return state;
      }
      return { liveAttachments: [...state.liveAttachments, attachment] };
    }),
  endLiveTurn: (turnId, conversationId) =>
    set((state) =>
      state.activeConversationId === conversationId &&
      state.liveTurn?.turnId === turnId &&
      state.liveTurn.conversationId === conversationId
        ? { liveTurn: undefined, liveAttachments: [] }
        : state,
    ),
  setQueue: (queue) =>
    set((state) =>
      state.activeConversationId === queue.conversationId ? { queue } : state,
    ),
  setLink: (link) => set({ link }),
  setStaged: (staged) => set({ staged }),
  addStaged: (attachment) =>
    set((state) => ({ staged: [...state.staged, attachment] })),
  removeStaged: (id) =>
    set((state) => ({
      staged: state.staged.filter((candidate) => candidate.id !== id),
    })),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setUiError: (uiError) => set({ uiError }),
}));

function mergeTranscript(
  authoritative: TranscriptEntry[],
  current: TranscriptEntry[],
): TranscriptEntry[] {
  const keys = new Set(authoritative.map(transcriptEntryKey));
  return [
    ...authoritative,
    ...current.filter((entry) => !keys.has(transcriptEntryKey(entry))),
  ];
}

function transcriptEntryKey(entry: TranscriptEntry): string {
  return `${entry.type}:${entry.turnId}`;
}
