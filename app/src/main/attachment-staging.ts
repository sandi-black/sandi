import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { StagedAttachment } from "@shared/ipc-contract";

import { isMissingFileError } from "./fs-errors";

// Composer attachments before submit. Picked and dropped files stay where
// they are (their path is the attachment); pasted images have no path, so
// they are written into a staging directory first. At submit time the turn
// pipeline uploads image attachments to the server's content-addressed store
// and lists file attachments by path for sandi's hands-local tools.

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Generous, matching the server's per-blob cap.
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 16;

export type AttachmentStaging = {
  stagePath(path: string): Promise<StagedAttachment | null>;
  stagePastedImage(dataUrl: string): Promise<StagedAttachment | null>;
  unstage(id: string): void;
  // Non-consuming lookup, for recording a submit's attachments in the
  // transcript while the turn itself may still be queued.
  peek(ids: string[]): StagedAttachment[];
  take(ids: string[]): StagedAttachment[];
};

export function createAttachmentStaging(stagingDir: string): AttachmentStaging {
  const staged = new Map<string, StagedAttachment>();
  let reservedSlots = 0;

  const reserveSlot = (): boolean => {
    if (staged.size + reservedSlots >= MAX_ATTACHMENTS_PER_TURN) return false;
    reservedSlots += 1;
    return true;
  };
  const releaseSlot = (): void => {
    reservedSlots -= 1;
  };

  return {
    async stagePath(path) {
      if (!reserveSlot()) return null;
      try {
        let size: number;
        try {
          const info = await stat(path);
          if (!info.isFile()) return null;
          size = info.size;
        } catch (error) {
          // A vanished path (dropped then deleted) is a normal no-op; a
          // permission or I/O error is not and must reach the caller.
          if (isMissingFileError(error)) return null;
          throw error;
        }
        if (size > MAX_ATTACHMENT_BYTES) return null;
        const name = basename(path);
        const mimeType = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
        const attachment: StagedAttachment = {
          id: randomUUID(),
          name,
          mimeType: mimeType ?? "application/octet-stream",
          size,
          kind: mimeType ? "image" : "file",
          path,
        };
        staged.set(attachment.id, attachment);
        return attachment;
      } finally {
        releaseSlot();
      }
    },

    async stagePastedImage(dataUrl) {
      if (!reserveSlot()) return null;
      try {
        const prefix = ["png", "jpeg", "webp"].find((mime) =>
          dataUrl.startsWith(`data:image/${mime};base64,`),
        );
        if (!prefix) return null;
        const encoded = dataUrl.slice(`data:image/${prefix};base64,`.length);
        if (!encoded) return null;
        const ext = prefix === "jpeg" ? "jpg" : prefix;
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
        await mkdir(stagingDir, { recursive: true });
        const id = randomUUID();
        const name = `pasted-${id}.${ext}`;
        const path = join(stagingDir, name);
        await writeFile(path, bytes);
        const attachment: StagedAttachment = {
          id,
          name,
          mimeType: `image/${prefix}`,
          size: bytes.byteLength,
          kind: "image",
          path,
        };
        staged.set(attachment.id, attachment);
        return attachment;
      } finally {
        releaseSlot();
      }
    },

    unstage(id) {
      staged.delete(id);
    },

    peek(ids) {
      const found: StagedAttachment[] = [];
      for (const id of ids) {
        const attachment = staged.get(id);
        if (attachment) found.push(attachment);
      }
      return found;
    },

    // Consumes staged attachments for a submit: they leave the tray whether
    // the turn later succeeds or fails (the transcript records them).
    take(ids) {
      const taken: StagedAttachment[] = [];
      for (const id of ids) {
        const attachment = staged.get(id);
        if (attachment) {
          taken.push(attachment);
          staged.delete(id);
        }
      }
      return taken;
    },
  };
}
