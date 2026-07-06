import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { StagedAttachment } from "@shared/ipc-contract";

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

  return {
    async stagePath(path) {
      let size: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        size = info.size;
      } catch {
        return null;
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
    },

    async stagePastedImage(dataUrl) {
      const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
      if (!match?.[1] || !match[2]) return null;
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
      await mkdir(stagingDir, { recursive: true });
      const name = `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
      const path = join(stagingDir, name);
      await writeFile(path, bytes);
      const attachment: StagedAttachment = {
        id: randomUUID(),
        name,
        mimeType: `image/${match[1]}`,
        size: bytes.byteLength,
        kind: "image",
        path,
      };
      staged.set(attachment.id, attachment);
      return attachment;
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
