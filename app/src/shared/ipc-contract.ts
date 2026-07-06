import type {
  PetBackground,
  PetOneShot,
  WanderDirection,
} from "./pet-state-machine";

// The typed surface between the Electron main process and the two renderer
// windows. Types only: this module is imported on both sides of the context
// bridge, so it must stay free of Node and Electron imports. The zod schemas
// that validate these payloads on arrival live main-side in
// src/main/ipc-schemas.ts.

export type LinkStatusState = "unpaired" | "connecting" | "linked" | "dropped";

export type LinkStatus = {
  state: LinkStatusState;
  message?: string;
};

// One conversation in the sidebar. Conversations are app-minted and device
// scoped; the server has no list endpoint, so this index is the app's own.
export type SessionSummary = {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastPreview: string;
};

// An attachment the user staged in the composer, before submit. Images are
// uploaded to the server's attachment store at submit time so they enter the
// model's visual context; other files ride along as desktop paths sandi reads
// with her own hands-local tools.
export type StagedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  path: string;
  // A small data: URL thumbnail for images, for the composer tray.
  previewDataUrl?: string;
};

// An attachment sandi added to a reply: a hands-local path on this machine.
export type ReplyAttachment = {
  path: string;
  name?: string;
  mimeType?: string;
};

export type TranscriptEntry =
  | {
      type: "user";
      turnId: string;
      ts: string;
      text: string;
      attachments?: { name: string; path: string; kind: "image" | "file" }[];
    }
  | {
      type: "assistant";
      turnId: string;
      ts: string;
      text: string;
      thinking?: string;
      attachments?: ReplyAttachment[];
    }
  | {
      type: "error";
      turnId: string;
      ts: string;
      text: string;
    };

export type QueuedTurnSummary = {
  turnId: string;
  text: string;
};

export type QueueState = {
  conversationId: string;
  inflightTurnId?: string;
  pending: QueuedTurnSummary[];
};

export type TurnDeltaEvent = {
  turnId: string;
  channel: "text" | "thinking";
  delta: string;
};

export type TurnAttachmentEvent = {
  turnId: string;
  attachment: ReplyAttachment;
};

export type TurnSettledEvent = {
  turnId: string;
  conversationId: string;
  ok: boolean;
  // The authoritative final text on success; the reason on failure.
  text?: string;
  error?: string;
};

// What the main process tells the pet renderer to play. The renderer runs the
// pure pet state machine over these plus its own animation-complete events.
export type PetDisplayEvent =
  | { type: "background"; background: PetBackground }
  | { type: "one-shot"; row: PetOneShot }
  | { type: "wander"; direction: WanderDirection }
  | { type: "wander-stop" };

export type PairOutcomeSummary =
  | { ok: true; identityId: string; deviceId: string }
  | { ok: false; error: string };

export type SaveAsOutcome = { ok: true; path: string } | { ok: false };

// The bridge exposed to the pet window as window.sandiPet.
export type SandiPetBridge = {
  dragStart(cursor: { x: number; y: number }): void;
  dragMove(cursor: { x: number; y: number }): void;
  dragEnd(): void;
  openChat(): void;
  // Toggled from alpha sampling so clicks pass through the sprite's
  // transparent pixels to the desktop beneath.
  setIgnoreMouseEvents(ignore: boolean): void;
  onDisplayEvent(listener: (event: PetDisplayEvent) => void): () => void;
};

// The bridge exposed to the chat window as window.sandiChat.
export type SandiChatBridge = {
  listSessions(): Promise<SessionSummary[]>;
  createSession(title?: string): Promise<SessionSummary>;
  selectSession(conversationId: string): Promise<TranscriptEntry[]>;
  renameSession(conversationId: string, title: string): Promise<void>;
  deleteSession(conversationId: string): Promise<void>;

  submitTurn(input: {
    conversationId: string;
    text: string;
    attachmentIds: string[];
  }): Promise<{ turnId: string }>;
  stopTurn(turnId: string): Promise<void>;
  cancelQueued(turnId: string): Promise<void>;

  pickAttachments(): Promise<StagedAttachment[]>;
  stageDroppedFile(file: File): Promise<StagedAttachment | null>;
  stagePastedImage(dataUrl: string): Promise<StagedAttachment | null>;
  unstageAttachment(id: string): Promise<void>;
  saveAttachmentAs(attachment: ReplyAttachment): Promise<SaveAsOutcome>;

  pair(code: string): Promise<PairOutcomeSummary>;
  getLinkStatus(): Promise<LinkStatus>;
  closeWindow(): void;

  onLinkStatus(listener: (status: LinkStatus) => void): () => void;
  onTurnDelta(listener: (event: TurnDeltaEvent) => void): () => void;
  onTurnAttachment(listener: (event: TurnAttachmentEvent) => void): () => void;
  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void;
  onQueueState(listener: (state: QueueState) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
};

// Channel names, shared by the preload scripts and the main-side handlers so
// a rename cannot silently split the two.
export const IPC = {
  petDragStart: "pet:drag-start",
  petDragMove: "pet:drag-move",
  petDragEnd: "pet:drag-end",
  petOpenChat: "pet:open-chat",
  petSetIgnoreMouse: "pet:set-ignore-mouse",
  petDisplayEvent: "pet:display-event",

  sessionList: "session:list",
  sessionCreate: "session:create",
  sessionSelect: "session:select",
  sessionRename: "session:rename",
  sessionDelete: "session:delete",
  sessionsChanged: "session:changed",

  turnSubmit: "turn:submit",
  turnStop: "turn:stop",
  turnCancelQueued: "turn:cancel-queued",
  turnDelta: "turn:delta",
  turnAttachment: "turn:attachment",
  turnSettled: "turn:settled",
  queueState: "queue:state",

  attachmentPick: "attachment:pick",
  attachmentStageDrop: "attachment:stage-drop",
  attachmentStagePaste: "attachment:stage-paste",
  attachmentUnstage: "attachment:unstage",
  attachmentSaveAs: "attachment:save-as",

  pairRedeem: "pair:redeem",
  linkStatus: "link:status",
  linkStatusGet: "link:status-get",

  chatClose: "chat:close",
} as const;
