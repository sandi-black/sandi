import { copyFile } from "node:fs/promises";
import { basename } from "node:path";

import type { SaveAsOutcome } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { dialog, ipcMain } from "electron";

import { ReplyAttachmentSchema } from "../ipc-schemas";

// Save-as for files sandi attached to a reply. The source is a hands-local
// path (she wrote it to this machine already); saving is a plain copy to
// wherever the human points the dialog.

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.attachmentSaveAs, async (_event, payload: unknown) => {
    const attachment = ReplyAttachmentSchema.parse(payload);
    const target = await dialog.showSaveDialog({
      defaultPath: attachment.name ?? basename(attachment.path),
      title: "Save Sandi's attachment",
    });
    if (target.canceled || !target.filePath) {
      const outcome: SaveAsOutcome = { ok: false };
      return outcome;
    }
    await copyFile(attachment.path, target.filePath);
    const outcome: SaveAsOutcome = { ok: true, path: target.filePath };
    return outcome;
  });
}
