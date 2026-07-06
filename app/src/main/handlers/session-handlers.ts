import { IPC } from "@shared/ipc-contract";
import { ipcMain } from "electron";

import { ConversationIdSchema, SessionTitleSchema } from "../ipc-schemas";
import type { TranscriptStore } from "../transcript-store";

// Session CRUD over the transcript store. Sessions are app-local; creating
// one does not touch the server (conversations are implicit there, born on
// their first turn).

export function registerSessionHandlers(input: {
  store: TranscriptStore;
  onSessionsChanged(): void;
}): void {
  const { store, onSessionsChanged } = input;

  ipcMain.handle(IPC.sessionList, () => store.listSessions());

  ipcMain.handle(IPC.sessionCreate, async (_event, title: unknown) => {
    const parsedTitle =
      title === undefined ? undefined : SessionTitleSchema.parse(title);
    const session = await store.createSession(parsedTitle);
    onSessionsChanged();
    return session;
  });

  ipcMain.handle(IPC.sessionSelect, (_event, conversationId: unknown) =>
    store.getTranscript(ConversationIdSchema.parse(conversationId)),
  );

  ipcMain.handle(
    IPC.sessionRename,
    async (_event, conversationId: unknown, title: unknown) => {
      await store.renameSession(
        ConversationIdSchema.parse(conversationId),
        SessionTitleSchema.parse(title),
      );
      onSessionsChanged();
    },
  );

  ipcMain.handle(IPC.sessionDelete, async (_event, conversationId: unknown) => {
    await store.deleteSession(ConversationIdSchema.parse(conversationId));
    onSessionsChanged();
  });
}
