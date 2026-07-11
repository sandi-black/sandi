import { IPC } from "@shared/ipc-contract";
import { ipcMain, type WebContents } from "electron";

import { requireIpcOwner } from "../ipc-owner";
import { ConversationIdSchema, SessionTitleSchema } from "../ipc-schemas";
import { deleteSessionIfIdle } from "../session-deletion";
import type { TranscriptStore } from "../transcript-store";

// Session CRUD over the transcript store. Sessions are app-local; creating
// one does not touch the server (conversations are implicit there, born on
// their first turn).

export function registerSessionHandlers(input: {
  owner: WebContents;
  store: TranscriptStore;
  hasWork(conversationId: string): boolean;
  onSessionsChanged(): void;
}): void {
  const { store, onSessionsChanged } = input;

  ipcMain.handle(IPC.sessionList, (event) => {
    requireIpcOwner(event, input.owner);
    return store.listSessions();
  });

  ipcMain.handle(IPC.sessionCreate, async (event, title: unknown) => {
    requireIpcOwner(event, input.owner);
    const parsedTitle =
      title === undefined ? undefined : SessionTitleSchema.parse(title);
    const session = await store.createSession(parsedTitle);
    onSessionsChanged();
    return session;
  });

  ipcMain.handle(IPC.sessionSelect, (event, conversationId: unknown) => {
    requireIpcOwner(event, input.owner);
    return store.getTranscript(ConversationIdSchema.parse(conversationId));
  });

  ipcMain.handle(
    IPC.sessionRename,
    async (event, conversationId: unknown, title: unknown) => {
      requireIpcOwner(event, input.owner);
      await store.renameSession(
        ConversationIdSchema.parse(conversationId),
        SessionTitleSchema.parse(title),
      );
      onSessionsChanged();
    },
  );

  ipcMain.handle(IPC.sessionDelete, async (event, conversationId: unknown) => {
    requireIpcOwner(event, input.owner);
    return deleteSessionIfIdle({
      conversationId: ConversationIdSchema.parse(conversationId),
      hasWork: input.hasWork,
      deleteSession: (id) => store.deleteSession(id),
      onDeleted: onSessionsChanged,
    });
  });
}
