import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AttachmentNameSchema,
  type AttachmentStore,
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
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
    sendAndDiscard(request, response, 400, "invalid_mime");
    return;
  }

  const nameHeader = request.headers["x-sandi-name"];
  const name = AttachmentNameSchema.safeParse(
    (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader)?.trim(),
  );
  if (!name.success) {
    sendAndDiscard(request, response, 400, "invalid_name");
    return;
  }

  const declaredLength = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ATTACHMENT_BYTES
  ) {
    sendAndDiscard(request, response, 413, "too_large");
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
      sendAndDiscard(request, response, 413, "too_large");
      return;
    }
    request.resume();
    throw error;
  }
}

function sendAndDiscard(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string,
): void {
  request.once("error", () => {});
  request.resume();
  sendJson(response, status, { error });
}
