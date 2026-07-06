import { createReadStream } from "node:fs";
import type { ServerResponse } from "node:http";

import type { AttachmentStore } from "@/surfaces/api/attachments/store";
import { sendJson } from "@/surfaces/api/http/respond";

// GET /v1/attachments/:hash: identity-scoped, so a hash that exists but belongs
// to another identity answers exactly like one that does not exist at all. This
// keeps the 404 from leaking whether a given hash is known to the server, only
// whether it is known to *this* caller.
export async function handleAttachmentDownload(
  response: ServerResponse,
  input: { store: AttachmentStore; hash: string; identityId: string },
): Promise<void> {
  const found = await input.store.get(input.hash, input.identityId);
  if (!found) {
    sendJson(response, 404, { error: "unknown_attachment" });
    return;
  }

  // Open the blob before committing success headers, so a sidecar whose blob
  // has gone missing (or unreadable) fails closed as a JSON error rather than
  // a 200 with a broken body.
  const stream = createReadStream(found.path);
  try {
    await new Promise<void>((resolveOpen, rejectOpen) => {
      stream.once("open", () => resolveOpen());
      stream.once("error", rejectOpen);
    });
  } catch {
    stream.destroy();
    // Metadata without readable bytes is a server-side inconsistency; answer
    // the same 404 as a missing attachment (fail closed, leak nothing).
    sendJson(response, 404, { error: "unknown_attachment" });
    return;
  }

  response.writeHead(200, {
    "content-type": found.metadata.mimeType,
    "content-length": found.metadata.size,
    "content-disposition": `attachment; filename="${sanitizeHeaderFilename(found.metadata.name)}"`,
  });

  try {
    await new Promise<void>((resolveStream, rejectStream) => {
      stream.on("error", rejectStream);
      stream.on("end", resolveStream);
      stream.pipe(response);
    });
  } catch {
    // Headers are already committed, so there is no error body to send; tear
    // the connection down so the client sees a truncated transfer, not a
    // silently short 200.
    stream.destroy();
    response.destroy();
  }
}

// A stored name is free-form (whatever the uploader sent), so it cannot be
// dropped into a header value verbatim: a quote or control character would
// break the header or smuggle a second one. Keep only printable ASCII other
// than the double quote that would terminate the value early; a code-point
// filter (rather than a regex with a control-character range) sidesteps
// Biome's no-control-characters-in-regex rule while doing the same job.
function sanitizeHeaderFilename(name: string): string {
  let stripped = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f && char !== '"') stripped += char;
  }
  return stripped.length > 0 ? stripped : "attachment";
}
