import { open } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";

import { errorMessage } from "@/lib/errors";
import type {
  DesktopFileAttachment,
  DesktopFileTransferParams,
} from "@/surfaces/api/devices/desktop-file-transfer";
import {
  DesktopFileAttachmentSchema,
  MAX_DESKTOP_FILE_TRANSFER_BYTES,
} from "@/surfaces/api/devices/desktop-file-transfer";
import type { ToolCallOutcome } from "@/surfaces/api/devices/protocol";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

/**
 * Reads a desktop file into the authenticated transfer channel without placing
 * its bytes in model-visible tool output. The fixed-size read is the final
 * guard against a file growing between stat and read.
 */
export async function transferDesktopFile(
  params: DesktopFileTransferParams,
  rootDir: string,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const path = isAbsolute(params.path)
    ? resolve(params.path)
    : resolve(rootDir, params.path);
  try {
    const data = await readBoundedFile(path, signal);
    const candidate: DesktopFileAttachment = {
      name: params.name ?? basename(path),
      mimeType:
        params.mimeType ??
        MIME_BY_EXTENSION[extname(path).toLowerCase()] ??
        "application/octet-stream",
      size: data.byteLength,
      dataBase64: data.toString("base64"),
    };
    const parsed = DesktopFileAttachmentSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error("file metadata cannot be represented safely for Discord");
    }
    const attachment = parsed.data;
    return {
      ok: true,
      content: [
        {
          type: "text",
          text: `prepared ${attachment.name} (${attachment.size} bytes) for Discord delivery`,
        },
      ],
      attachment,
    };
  } catch (error) {
    return { ok: false, content: [], error: errorMessage(error) };
  }
}

async function readBoundedFile(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("path is not a regular file");
    if (metadata.size > MAX_DESKTOP_FILE_TRANSFER_BYTES) {
      throw new Error(
        `file exceeds the ${MAX_DESKTOP_FILE_TRANSFER_BYTES}-byte Discord transfer limit`,
      );
    }
    const buffer = Buffer.alloc(MAX_DESKTOP_FILE_TRANSFER_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_DESKTOP_FILE_TRANSFER_BYTES) {
      throw new Error(
        `file exceeds the ${MAX_DESKTOP_FILE_TRANSFER_BYTES}-byte Discord transfer limit`,
      );
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
