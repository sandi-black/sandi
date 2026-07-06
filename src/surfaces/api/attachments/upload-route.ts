import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type AttachmentStore,
  AttachmentTooLargeError,
  isSupportedAttachmentMimeType,
} from "@/surfaces/api/attachments/store";
import { sendJson } from "@/surfaces/api/http/respond";

// A caller cannot always name a filename-safe string; cap it well short of any
// filesystem limit and forbid path separators so a header value can never be
// read as a directory traversal once it reaches the temp-dir materializer.
const MAX_NAME_LENGTH = 200;

// POST /v1/attachments: a raw-body upload, not JSON. The content-type header
// is the mime, a custom header carries the filename (there is no standard HTTP
// header for it outside multipart, which this route deliberately avoids so a
// single stream can be hashed as it arrives rather than parsed and buffered as
// distinct multipart fields). The caller has already been authenticated by
// api-bot before this handler runs.
export async function handleAttachmentUpload(
  request: IncomingMessage,
  response: ServerResponse,
  input: { store: AttachmentStore; identityId: string },
): Promise<void> {
  const mimeType = (request.headers["content-type"] ?? "")
    .toString()
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!mimeType || !isSupportedAttachmentMimeType(mimeType)) {
    sendJson(response, 400, { error: "invalid_mime" });
    return;
  }

  const nameHeader = request.headers["x-sandi-name"];
  const name = validateAttachmentName(
    Array.isArray(nameHeader) ? nameHeader[0] : nameHeader,
  );
  if (!name) {
    sendJson(response, 400, { error: "invalid_name" });
    return;
  }

  try {
    const result = await input.store.upload({
      body: request,
      mimeType,
      name,
      identityId: input.identityId,
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) {
      sendJson(response, 413, { error: "too_large" });
      return;
    }
    throw error;
  }
}

// A non-empty name, capped in length, with no path separator: it becomes a
// filename in a per-turn temp directory later, never a path.
function validateAttachmentName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH)
    return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) return undefined;
  return trimmed;
}
