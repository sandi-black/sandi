import { copyFile } from "node:fs/promises";
import { basename } from "node:path";

import type { SaveAsOutcome } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { dialog, ipcMain, type WebContents } from "electron";

import { requireIpcOwner } from "../ipc-owner";
import { LocalPathSchema, ReplyAttachmentSchema } from "../ipc-schemas";

// Save-as for files sandi attached to a reply. The source is a hands-local
// path (she wrote it to this machine already); saving is a plain copy to
// wherever the human points the dialog.

export function registerFileHandlers(input: { owner: WebContents }): void {
  ipcMain.handle(IPC.attachmentSaveAs, async (event, payload: unknown) => {
    requireIpcOwner(event, input.owner);
    const attachment = ReplyAttachmentSchema.parse(payload);
    const target = await dialog.showSaveDialog({
      defaultPath: attachment.name ?? basename(attachment.path),
      title: "Save Sandi's attachment",
    });
    // The dialog's answer is an external value like any other: it must be a
    // bounded absolute path before copyFile writes to it or the renderer
    // hears about it.
    const destination = LocalPathSchema.safeParse(target.filePath);
    if (target.canceled || !destination.success) {
      const outcome: SaveAsOutcome = { ok: false };
      return outcome;
    }
    await copyFile(attachment.path, destination.data);
    const outcome: SaveAsOutcome = { ok: true, path: destination.data };
    return outcome;
  });
}
