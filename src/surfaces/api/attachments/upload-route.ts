import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AttachmentNameSchema,
  type AttachmentStore,
  AttachmentTooLargeError,
  SupportedAttachmentMimeTypeSchema,
} from "@/surfaces/api/attachments/store";
import { sendJson } from "@/surfaces/api/http/respond";

// POST /v1/attachments: a raw-body upload, not JSON. The content-type header
// is the mime, a custom header carries the filename (there is no standard HTTP
// header for it outside multipart, which this route deliberately avoids so a
// single stream can be hashed as it arrives rather than parsed and buffered as
// distinct multipart fields). The caller has already been authenticated by
// api-bot before this handler runs. Both headers parse against the store's
// own boundary schemas before anything enters it.
export async function handleAttachmentUpload(
  request: IncomingMessage,
  response: ServerResponse,
  input: { store: AttachmentStore; identityId: string },
): Promise<void> {
  // Normalize the header's media-type syntax (parameters stripped, case
  // folded) and then parse it against the supported set.
  const rawMime = (request.headers["content-type"] ?? "")
    .toString()
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  const mimeType = SupportedAttachmentMimeTypeSchema.safeParse(rawMime);
  if (!mimeType.success) {
    sendJson(response, 400, { error: "invalid_mime" });
    return;
  }

  const nameHeader = request.headers["x-sandi-name"];
  const name = AttachmentNameSchema.safeParse(
    (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader)?.trim(),
  );
  if (!name.success) {
    sendJson(response, 400, { error: "invalid_name" });
    return;
  }

  try {
    const result = await input.store.upload({
      body: request,
      mimeType: mimeType.data,
      name: name.data,
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
