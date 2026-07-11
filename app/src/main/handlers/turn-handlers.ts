import { randomUUID } from "node:crypto";

import { IPC } from "@shared/ipc-contract";
import { ipcMain, type WebContents } from "electron";

import type { AttachmentStaging } from "../attachment-staging";
import type { AutoTitler } from "../auto-titler";
import { requireIpcOwner } from "../ipc-owner";
import {
  ConversationIdSchema,
  SubmitTurnSchema,
  TurnIdSchema,
} from "../ipc-schemas";
import type { TranscriptStore } from "../transcript-store";
import type { TurnManager } from "../turn-manager";

// Turn submission and control. The user's message lands in the transcript at
// submit time (with its attachment metadata), before the turn has even left
// the queue; the assistant's side lands when the turn settles.

export function registerTurnHandlers(input: {
  owner: WebContents;
  turnManager: TurnManager;
  store: TranscriptStore;
  staging: AttachmentStaging;
  autoTitler: AutoTitler;
}): void {
  const { turnManager, store, staging, autoTitler } = input;

  ipcMain.handle(IPC.turnSubmit, async (event, payload: unknown) => {
    requireIpcOwner(event, input.owner);
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
    // Name a fresh conversation from its opening message, in the background:
    // the guard inside only titles a still-unnamed conversation once, so this
    // is a no-op on every later message. Fire-and-forget, so a preflight
    // rejection (an unreadable session index, say) is caught and logged here
    // rather than surfacing as an unhandled rejection off the IPC handler.
    autoTitler
      .maybeTitle({
        conversationId: parsed.conversationId,
        message: parsed.text,
      })
      .catch((error: unknown) => {
        console.error("auto-title failed", error);
      });
    return { turnId };
  });

  ipcMain.handle(IPC.turnStop, (event, turnId: unknown) => {
    requireIpcOwner(event, input.owner);
    turnManager.stop(TurnIdSchema.parse(turnId));
  });

  ipcMain.handle(IPC.turnCancelQueued, (event, turnId: unknown) => {
    requireIpcOwner(event, input.owner);
    turnManager.cancelQueued(TurnIdSchema.parse(turnId));
  });

  ipcMain.handle(IPC.queueStateGet, (event, conversationId: unknown) => {
    requireIpcOwner(event, input.owner);
    return turnManager.queueState(ConversationIdSchema.parse(conversationId));
  });
}
