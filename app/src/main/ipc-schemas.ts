import { z } from "zod/v4";

// Runtime validation for renderer-to-main IPC payloads. The renderer is our
// own code, but main never trusts renderer JSON blindly: a dependency
// compromise in the renderer should not get a free pass into the process that
// holds credentials and the device link.

export const CursorPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const IgnoreMouseSchema = z.boolean();

export const SubmitTurnSchema = z.object({
  conversationId: z.string().min(1).max(200),
  text: z.string().min(1).max(200_000),
  attachmentIds: z.array(z.string().min(1)).max(16),
});

export const TurnIdSchema = z.string().min(1).max(200);

export const SessionTitleSchema = z.string().min(1).max(200);

export const ConversationIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,200}$/);

export const PairCodeSchema = z.string().min(1).max(200);

export const StagePasteSchema = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/);

export const AttachmentIdSchema = z.string().min(1).max(200);

export const ReplyAttachmentSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  mimeType: z.string().min(1).max(200).optional(),
});
