import { isAbsolute } from "node:path";

import { z } from "zod/v4";

// Runtime validation for renderer-to-main IPC payloads. The renderer is our
// own code, but main never trusts renderer JSON blindly: a dependency
// compromise in the renderer should not get a free pass into the process that
// holds credentials and the device link.

// True when a string carries a NUL byte (code point 0). Node's fs calls throw
// on a NUL in a path rather than failing cleanly, so paths reject it at the
// boundary before anything reaches stat/copyFile/pathToFileURL.
function containsNul(value: string): boolean {
  return value.includes(String.fromCharCode(0));
}

// True when a string is a safe single on-disk filename: no path separators (so
// it cannot escape its directory when used as a basename) and no C0/DEL
// control bytes (code points 0-31 and 127), which corrupt the name a save
// dialog default or a copyFile destination later relies on.
function isSafeFilename(value: string): boolean {
  for (const char of value) {
    if (char === "/" || char === "\\") return false;
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

// Any absolute path is acceptable by design (sandi has the human's own reach
// on this machine), but a value that reaches stat/copyFile/upload must
// actually be one: bounded, absolute, NUL-free, never relative or empty.
export const LocalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !containsNul(value), "must not contain a NUL byte")
  .refine(isAbsolute, "must be an absolute local path");

// Shared by every boundary that takes a display or save-as name.
export const FilesystemSafeFilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isSafeFilename, "must be a filesystem-safe single filename");

export const CursorPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const IgnoreMouseSchema = z.boolean();

// Conversation ids become JSONL filenames in the transcript store, so the
// shape is strict everywhere one crosses a boundary: IPC, the on-disk index,
// and turn submission all share this schema.
export const ConversationIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,200}$/);

export const SubmitTurnSchema = z.object({
  conversationId: ConversationIdSchema,
  text: z.string().min(1).max(200_000),
  attachmentIds: z.array(z.string().min(1)).max(16),
});

export const TurnIdSchema = z.string().min(1).max(200);

export const SessionTitleSchema = z.string().min(1).max(200);

// A dropped file's path as resolved by the preload (webUtils.getPathForFile).
export const AttachmentPathSchema = LocalPathSchema;

export const PairCodeSchema = z.string().min(1).max(200);

// A pasted image arrives as a data URL the renderer built from the clipboard.
// Beyond the media-type prefix, the payload must be canonical base64 so it
// decodes to exactly the bytes it claims rather than something Buffer.from
// silently coerces, and it must fit the same cap the attachment store enforces
// so a paste cannot smuggle in an oversized blob the upload would later reject.
// The declared image type is trusted rather than magic-byte sniffed: this is
// the human's own clipboard on their own machine, so sniffing would add cost
// without answering any threat sandi is not already trusted with.
const PASTED_IMAGE_PREFIX = /^data:image\/(?:png|jpeg|webp);base64,/;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;

function decodedBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export const StagePasteSchema = z
  .string()
  .min(1)
  .max(96_000_000)
  .refine(
    (value) => PASTED_IMAGE_PREFIX.test(value),
    "must be a supported image data URL",
  )
  .refine((value) => {
    const base64 = value.slice(value.indexOf(",") + 1);
    return base64.length > 0 && CANONICAL_BASE64.test(base64);
  }, "image payload must be canonical base64")
  .refine(
    (value) =>
      decodedBase64Bytes(value.slice(value.indexOf(",") + 1)) <=
      MAX_PASTED_IMAGE_BYTES,
    "pasted image exceeds the size cap",
  );

export const AttachmentIdSchema = z.string().min(1).max(200);

// A reply attachment's path is absolute by the time it exists app-side (the
// link boundary resolves desktop-relative paths from the wire against the
// home dir before anything stores or renders them); name is a filesystem-safe
// single filename because save-as offers it as the default.
export const ReplyAttachmentSchema = z.object({
  path: LocalPathSchema,
  name: FilesystemSafeFilenameSchema.optional(),
  mimeType: z
    .string()
    .regex(/^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/)
    .optional(),
});
