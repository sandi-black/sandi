import type { StagedAttachment } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { dialog, ipcMain } from "electron";

import type { AttachmentStaging } from "../attachment-staging";
import {
  AttachmentIdSchema,
  AttachmentPathSchema,
  StagePasteSchema,
} from "../ipc-schemas";

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
      // Same boundary discipline as a dropped path: the dialog's strings are
      // external values and must parse as bounded absolute paths before
      // anything stats them.
      const parsed = AttachmentPathSchema.safeParse(path);
      if (!parsed.success) continue;
      const attachment = await staging.stagePath(parsed.data);
      if (attachment) staged.push(attachment);
    }
    return staged;
  });

  ipcMain.handle(IPC.attachmentStageDrop, (_event, path: unknown) => {
    const parsed = AttachmentPathSchema.safeParse(path);
    if (!parsed.success) return null;
    return staging.stagePath(parsed.data);
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
