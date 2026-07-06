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
  thinking: string;
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
  showThinking: boolean;
  drawerOpen: boolean;

  setSessions(sessions: SessionSummary[]): void;
  setActive(conversationId: string, transcript: TranscriptEntry[]): void;
  appendTranscript(entry: TranscriptEntry): void;
  beginLiveTurn(turnId: string, conversationId: string): void;
  appendDelta(
    turnId: string,
    channel: "text" | "thinking",
    delta: string,
  ): void;
  appendLiveAttachment(turnId: string, attachment: ReplyAttachment): void;
  endLiveTurn(turnId: string): void;
  setQueue(queue: QueueState): void;
  setLink(link: LinkStatus): void;
  setStaged(staged: StagedAttachment[]): void;
  addStaged(attachment: StagedAttachment): void;
  removeStaged(id: string): void;
  setShowThinking(show: boolean): void;
  setDrawerOpen(open: boolean): void;
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
  showThinking: false,
  drawerOpen: false,

  setSessions: (sessions) => set({ sessions }),
  setActive: (conversationId, transcript) =>
    set({
      activeConversationId: conversationId,
      transcript,
      liveTurn: undefined,
      liveAttachments: [],
      drawerOpen: false,
    }),
  appendTranscript: (entry) =>
    set((state) => ({ transcript: [...state.transcript, entry] })),
  beginLiveTurn: (turnId, conversationId) =>
    set({
      liveTurn: { turnId, conversationId, text: "", thinking: "" },
      liveAttachments: [],
    }),
  appendDelta: (turnId, channel, delta) =>
    set((state) => {
      if (state.liveTurn?.turnId !== turnId) return state;
      const liveTurn = { ...state.liveTurn };
      if (channel === "thinking") {
        liveTurn.thinking += delta;
      } else {
        liveTurn.text += delta;
      }
      return { liveTurn };
    }),
  appendLiveAttachment: (turnId, attachment) =>
    set((state) => {
      if (state.liveTurn?.turnId !== turnId) return state;
      return { liveAttachments: [...state.liveAttachments, attachment] };
    }),
  endLiveTurn: (turnId) =>
    set((state) =>
      state.liveTurn?.turnId === turnId
        ? { liveTurn: undefined, liveAttachments: [] }
        : state,
    ),
  setQueue: (queue) => set({ queue }),
  setLink: (link) => set({ link }),
  setStaged: (staged) => set({ staged }),
  addStaged: (attachment) =>
    set((state) => ({ staged: [...state.staged, attachment] })),
  removeStaged: (id) =>
    set((state) => ({
      staged: state.staged.filter((candidate) => candidate.id !== id),
    })),
  setShowThinking: (showThinking) => set({ showThinking }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
}));
