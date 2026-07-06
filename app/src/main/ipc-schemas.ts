import { isAbsolute } from "node:path";

import { z } from "zod/v4";

// Runtime validation for renderer-to-main IPC payloads. The renderer is our
// own code, but main never trusts renderer JSON blindly: a dependency
// compromise in the renderer should not get a free pass into the process that
// holds credentials and the device link.

// Any absolute path is acceptable by design (sandi has the human's own reach
// on this machine), but a value that reaches stat/copyFile/upload must
// actually be one: bounded and absolute, never relative or empty.
export const LocalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "must be an absolute local path");

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

export const StagePasteSchema = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/);

export const AttachmentIdSchema = z.string().min(1).max(200);

// A reply attachment's path is absolute by the time it exists app-side (the
// link boundary resolves desktop-relative paths from the wire against the
// home dir before anything stores or renders them); name is a single bounded
// filename because save-as offers it as the default.
export const ReplyAttachmentSchema = z.object({
  path: LocalPathSchema,
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) => !value.includes("/") && !value.includes("\\"),
      "name must be a single filename, not a path",
    )
    .optional(),
  mimeType: z
    .string()
    .regex(/^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/)
    .optional(),
});
