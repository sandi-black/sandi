import { Buffer } from "node:buffer";

import { z } from "zod/v4";

// The public device-result route is capped at 8 MiB of JSON. A 4.5 MiB file
// expands to exactly 6 MiB of base64, leaving room for the result envelope.
export const MAX_DESKTOP_FILE_TRANSFER_BYTES = 4_500_000;
export const MAX_DESKTOP_FILE_TRANSFER_BASE64_CHARS = 6_000_000;

const SafeFilenameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isSafeFilename, "must be a safe single filename");

const MimeTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu,
    "must be a MIME type",
  );

export const DesktopFileTransferParamsSchema = z.object({
  desktop: z.string().min(1).optional(),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => !value.includes(String.fromCharCode(0)),
      "path must not contain a NUL byte",
    ),
  name: SafeFilenameSchema.optional(),
  mimeType: MimeTypeSchema.optional(),
});
export type DesktopFileTransferParams = z.infer<
  typeof DesktopFileTransferParamsSchema
>;

export const DesktopFileAttachmentSchema = z
  .object({
    name: SafeFilenameSchema,
    mimeType: MimeTypeSchema,
    size: z.number().int().nonnegative().max(MAX_DESKTOP_FILE_TRANSFER_BYTES),
    dataBase64: z
      .string()
      .max(MAX_DESKTOP_FILE_TRANSFER_BASE64_CHARS)
      .refine(isCanonicalBase64, "must be canonical base64"),
  })
  .refine(
    (attachment) =>
      Buffer.from(attachment.dataBase64, "base64").byteLength ===
      attachment.size,
    { message: "size does not match the encoded file", path: ["size"] },
  );
export type DesktopFileAttachment = z.infer<typeof DesktopFileAttachmentSchema>;

export const DiscordDesktopFileRequestSchema =
  DesktopFileTransferParamsSchema.extend({
    content: z.string().max(2000).optional(),
  }).strict();
export type DiscordDesktopFileRequest = z.infer<
  typeof DiscordDesktopFileRequestSchema
>;

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value;
}

function isSafeFilename(value: string): boolean {
  if (value === "." || value === "..") return false;
  for (const char of value) {
    if (char === "/" || char === "\\") return false;
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}
