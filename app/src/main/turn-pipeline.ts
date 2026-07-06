import { readFile } from "node:fs/promises";

import type { AttachmentStaging } from "./attachment-staging";
import type { SendTurnFn } from "./turn-manager";
import {
  desktopConfigPath,
  loadDesktopCredentials,
} from "@sandi-server/surfaces/api/client/credentials";
import { sendTurn } from "@sandi-server/surfaces/api/client/turns";
import { z } from "zod/v4";

// Builds and sends one turn: uploads image attachments to the server's
// content-addressed store (so they enter the model's visual context), lists
// file attachments by desktop path (sandi reads those herself with her
// hands-local tools), and posts the turn. Credentials load fresh from disk on
// every send so a re-pair in the CLI takes effect without restarting the app.

export function createTurnPipeline(input: {
  staging: AttachmentStaging;
}): SendTurnFn {
  return async ({ conversationId, text, turnId, attachmentIds, signal }) => {
    const credentials = await loadDesktopCredentials(desktopConfigPath());
    if (!credentials) {
      return {
        ok: false,
        error: "not paired; enter a /sandi auth code first",
      };
    }

    const attachments = input.staging.take(attachmentIds);
    const images = attachments.filter((item) => item.kind === "image");
    const files = attachments.filter((item) => item.kind === "file");

    const refs: { hash: string; name?: string }[] = [];
    for (const image of images) {
      const uploaded = await uploadAttachment({
        url: credentials.url,
        token: credentials.token,
        path: image.path,
        name: image.name,
        mimeType: image.mimeType,
        signal,
      });
      if (!uploaded.ok) {
        return {
          ok: false,
          error: `could not upload ${image.name}: ${uploaded.error}`,
        };
      }
      refs.push({ hash: uploaded.hash, name: image.name });
    }

    return sendTurn({
      url: credentials.url,
      token: credentials.token,
      conversationId,
      input: withFileReferences(
        text,
        files.map((file) => file.path),
      ),
      turnId,
      signal,
      ...(refs.length > 0 ? { attachments: refs } : {}),
    });
  };
}

// Non-image attachments already live on this desktop, where sandi's tools
// run; naming their paths is all she needs to read them.
function withFileReferences(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `${text}\n\nAttached files on my desktop (read them with your local tools):\n${list}`;
}

// The upload response is external JSON, and its hash flows straight into the
// turn body, so the whole shape is parsed, including the store's canonical
// 64-hex sha256 form, rather than probing for any string-valued hash.
const UploadResponseSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

type UploadOutcome = { ok: true; hash: string } | { ok: false; error: string };

async function uploadAttachment(input: {
  url: string;
  token: string;
  path: string;
  name: string;
  mimeType: string;
  signal: AbortSignal;
}): Promise<UploadOutcome> {
  let body: Buffer;
  try {
    body = await readFile(input.path);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let response: Response;
  try {
    response = await fetch(new URL("/v1/attachments", input.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": input.mimeType,
        "x-sandi-name": input.name,
      },
      body: new Uint8Array(body),
      signal: input.signal,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    return { ok: false, error: `upload failed (status ${response.status})` };
  }
  try {
    const parsed = UploadResponseSchema.safeParse(await response.json());
    if (parsed.success) return { ok: true, hash: parsed.data.hash };
  } catch {
    // Non-JSON body: fall through to the generic error below.
  }
  return { ok: false, error: "upload returned an unexpected body" };
}
