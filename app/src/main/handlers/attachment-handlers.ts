import type { StagedAttachment } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { dialog, ipcMain } from "electron";

import type { AttachmentStaging } from "../attachment-staging";
import { AttachmentIdSchema, StagePasteSchema } from "../ipc-schemas";

// Composer attachment intake: the native file picker, dropped paths (resolved
// by the preload via webUtils.getPathForFile), and pasted images.

export function registerAttachmentHandlers(input: {
  staging: AttachmentStaging;
}): void {
  const { staging } = input;

  ipcMain.handle(IPC.attachmentPick, async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: "Attach files for Sandi",
    });
    if (picked.canceled) return [];
    const staged: StagedAttachment[] = [];
    for (const path of picked.filePaths) {
      const attachment = await staging.stagePath(path);
      if (attachment) staged.push(attachment);
    }
    return staged;
  });

  ipcMain.handle(IPC.attachmentStageDrop, (_event, path: unknown) => {
    if (typeof path !== "string" || path.length === 0) return null;
    return staging.stagePath(path);
  });

  ipcMain.handle(IPC.attachmentStagePaste, (_event, dataUrl: unknown) => {
    const parsed = StagePasteSchema.safeParse(dataUrl);
    if (!parsed.success) return null;
    return staging.stagePastedImage(parsed.data);
  });

  ipcMain.handle(IPC.attachmentUnstage, (_event, id: unknown) => {
    staging.unstage(AttachmentIdSchema.parse(id));
  });
}
