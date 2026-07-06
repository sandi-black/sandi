import { randomUUID } from "node:crypto";

import { IPC } from "@shared/ipc-contract";
import { ipcMain } from "electron";

import type { AttachmentStaging } from "../attachment-staging";
import { SubmitTurnSchema, TurnIdSchema } from "../ipc-schemas";
import type { TranscriptStore } from "../transcript-store";
import type { TurnManager } from "../turn-manager";

// Turn submission and control. The user's message lands in the transcript at
// submit time (with its attachment metadata), before the turn has even left
// the queue; the assistant's side lands when the turn settles.

export function registerTurnHandlers(input: {
  turnManager: TurnManager;
  store: TranscriptStore;
  staging: AttachmentStaging;
}): void {
  const { turnManager, store, staging } = input;

  ipcMain.handle(IPC.turnSubmit, async (_event, payload: unknown) => {
    const parsed = SubmitTurnSchema.parse(payload);
    const turnId = randomUUID();
    const attached = staging.peek(parsed.attachmentIds);
    await store.appendEntry(parsed.conversationId, {
      type: "user",
      turnId,
      ts: new Date().toISOString(),
      text: parsed.text,
      ...(attached.length > 0
        ? {
            attachments: attached.map((item) => ({
              name: item.name,
              path: item.path,
              kind: item.kind,
            })),
          }
        : {}),
    });
    turnManager.submit({
      conversationId: parsed.conversationId,
      text: parsed.text,
      turnId,
      attachmentIds: parsed.attachmentIds,
    });
    return { turnId };
  });

  ipcMain.handle(IPC.turnStop, (_event, turnId: unknown) => {
    turnManager.stop(TurnIdSchema.parse(turnId));
  });

  ipcMain.handle(IPC.turnCancelQueued, (_event, turnId: unknown) => {
    turnManager.cancelQueued(TurnIdSchema.parse(turnId));
  });
}
