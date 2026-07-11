import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

import { z } from "zod/v4";
import { isMissingFileError } from "@/lib/fs-errors";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";

// Content-addressed storage for attachments a caller uploads or a turn
// references. A blob is named by its own sha256, so two identities uploading
// the same bytes share one copy on disk; ownership (who may read it back) is
// tracked in a sidecar rather than the path, since the path is derived purely
// from content.

// Kept generous but bounded: an attachment rides through a turn's context, and a
// per-turn cap this size keeps a single upload from dwarfing everything else the
// model has to hold. Enforced while streaming, not after, so an oversized upload
// is abandoned mid-transfer rather than fully buffered first.
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

// The mime types Sandi accepts today. Images cover the common attach-a-photo
// case; octet-stream is the fallback for anything the caller does not label more
// specifically. Exported as a const (not baked into a private set) so widening
// this list later is a one-line change here, not a hunt through the module.
export const SUPPORTED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/octet-stream",
] as const;

// The boundary schemas for the two upload headers, owned here alongside the
// sidecar schema they feed so the wire shape and the stored shape cannot
// drift: a supported mime type, and a single bounded filename (it becomes a
// materialized file's basename, so path separators are rejected outright).
export const SupportedAttachmentMimeTypeSchema = z.enum(
  SUPPORTED_ATTACHMENT_MIME_TYPES,
);
export type SupportedAttachmentMimeType = z.infer<
  typeof SupportedAttachmentMimeTypeSchema
>;

// A safe single on-disk filename: no path separators (it must not escape its
// directory when used as a materialized blob's basename) and no C0/DEL control
// bytes (code points 0-31 and 127), which corrupt the name copyFile and the
// desktop save-as later rely on. Written with code-point checks rather than a
// control-char regex literal so the source stays plain ASCII.
export function isFilesystemSafeName(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 240) return false;
  if (value.endsWith(".") || value.endsWith(" ")) return false;
  const windowsStem = value.split(".")[0]?.toUpperCase();
  if (
    windowsStem === "CON" ||
    windowsStem === "PRN" ||
    windowsStem === "AUX" ||
    windowsStem === "NUL" ||
    /^COM[1-9]$/.test(windowsStem ?? "") ||
    /^LPT[1-9]$/.test(windowsStem ?? "")
  ) {
    return false;
  }
  for (const char of value) {
    if ('/\\<>:"|?*'.includes(char)) return false;
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export const AttachmentNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    isFilesystemSafeName,
    "name must be a filesystem-safe single filename",
  );

const SHA256_HEX = /^[0-9a-f]{64}$/;

// A sidecar is written by this module, but it is still a disk boundary: a
// corrupted or hand-edited file must not carry header-unsafe metadata deeper
// into the program. mimeType must be a plain type/subtype token pair (it
// becomes the download's Content-Type header verbatim), name must be a
// bounded single filename (it becomes a materialized file's basename), and
// size is bounded by the upload cap it was enforced against.
const MIME_TOKEN_PAIR = /^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/;

const AttachmentMetadataSchema = z.object({
  hash: z.string().regex(SHA256_HEX, "hash must be 64 lowercase hex chars"),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  mimeType: z
    .string()
    .regex(MIME_TOKEN_PAIR, "mimeType must be a type/subtype token pair"),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      isFilesystemSafeName,
      "name must be a filesystem-safe single filename",
    ),
  ownerIdentityIds: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(),
});
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

export class AttachmentTooLargeError extends Error {
  constructor() {
    super(`attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte cap`);
    this.name = "AttachmentTooLargeError";
  }
}

export type AttachmentUploadResult = {
  hash: string;
  size: number;
  mimeType: string;
  name: string;
};

export type AttachmentReadResult = {
  metadata: AttachmentMetadata;
  path: string;
};

type WriterOutcome = { ok: true } | { ok: false; error: unknown };

type AttachmentStoreOptions = {
  createWriter?: (path: string) => Writable;
};

// Blobs live at attachments/<first 2 hex chars>/<hash>, sharded by the hash's
// own prefix so one directory never accumulates every blob the server has ever
// seen. The sidecar `<hash>.json` sits alongside the blob it describes.
export class AttachmentStore {
  readonly #root: string;
  readonly #createWriter: (path: string) => Writable;

  constructor(root: string, options: AttachmentStoreOptions = {}) {
    this.#root = root;
    this.#createWriter =
      options.createWriter ??
      ((path) => createWriteStream(path, { flags: "wx" }));
  }

  // Streams a request body into the store, hashing as it goes. The upload lands
  // at a temp path in the same shard directory the final blob would use, so the
  // rename into place is a same-volume atomic move rather than a cross-device
  // copy. Dedup: if the hash already exists, the temp file is discarded and only
  // the sidecar gains the uploader (and fills in name/mime if the stored ones
  // were never set), so re-uploading identical bytes never duplicates storage.
  async upload(input: {
    body: Readable;
    mimeType: string;
    name: string;
    identityId: string;
    maxBytes?: number;
  }): Promise<AttachmentUploadResult> {
    const cap = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const stagingDir = join(this.#root, "_staging");
    await mkdir(stagingDir, { recursive: true });
    const tempPath = join(stagingDir, `${randomBytes(16).toString("hex")}.tmp`);

    try {
      const hash = createHash("sha256");
      let size = 0;
      const writeStream = this.#createWriter(tempPath);
      const writerOutcome: Promise<WriterOutcome> = finished(writeStream, {
        cleanup: true,
      }).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      const bodyIterator = input.body.iterator({ destroyOnReturn: false });
      try {
        // `iterator({ destroyOnReturn: false })` lets the HTTP route send a 413
        // before it drains and closes an oversized request. The ordinary
        // Readable async iterator destroys the request socket when this loop
        // throws, which would make that response unreachable.
        while (true) {
          const selected = await Promise.race([
            bodyIterator
              .next()
              .then((value) => ({ kind: "body", value }) as const),
            writerOutcome.then((value) => ({ kind: "writer", value }) as const),
          ]);
          if (selected.kind === "writer") {
            throwWriterOutcome(selected.value);
          }
          if (selected.value.done) break;

          const value = selected.value.value;
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.length;
          if (size > cap) throw new AttachmentTooLargeError();
          hash.update(chunk);
          if (!writeStream.write(chunk)) {
            const ready = await Promise.race([
              once(writeStream, "drain").then(
                () => ({ kind: "drain" }) as const,
              ),
              writerOutcome.then(
                (outcome) => ({ kind: "writer", outcome }) as const,
              ),
            ]);
            if (ready.kind === "writer") throwWriterOutcome(ready.outcome);
          }
        }
        writeStream.end();
        const outcome = await writerOutcome;
        if (!outcome.ok) throw outcome.error;
      } catch (error) {
        const iteratorReturn = bodyIterator.return?.();
        void iteratorReturn?.catch(() => {});
        writeStream.destroy();
        await writerOutcome;
        throw error;
      }

      const digest = hash.digest("hex");
      const blobPath = this.#blobPath(digest);
      const metaPath = this.#metadataPath(digest);
      await mkdir(this.#shardDir(digest), { recursive: true });

      // Two identities (or two turns from the same identity) can upload identical
      // bytes at once; each is a separate process, so the read-modify-write of the
      // sidecar runs under the cross-process managed-write lock keyed by its own
      // path, exactly like every other Sandi-managed state file. The blob rename
      // itself is a plain filesystem atomic op and idempotent for identical
      // content, so it does not need the lock.
      return await withManagedWrite(metaPath, async () => {
        const existing = await this.#readMetadata(digest);
        if (existing) {
          // Dedup: the bytes are already stored, so discard the freshly uploaded
          // temp copy and only extend the sidecar's ownership. But trust the
          // disk, not the sidecar: a stale sidecar whose blob has gone missing
          // would otherwise report success for a hash later reads fail on, so
          // the fresh upload restores the blob instead of being discarded.
          if (await blobIsPresent(blobPath)) {
            await rm(tempPath, { force: true });
          } else {
            await rename(tempPath, blobPath);
          }
          const merged: AttachmentMetadata = {
            ...existing,
            name: existing.name || input.name,
            mimeType: existing.mimeType || input.mimeType,
            ownerIdentityIds: addOwner(
              existing.ownerIdentityIds,
              input.identityId,
            ),
          };
          await this.#writeMetadata(metaPath, merged);
          return {
            hash: digest,
            size: existing.size,
            mimeType: merged.mimeType,
            name: merged.name,
          };
        }

        // Rename into place before writing the sidecar, so a reader can never see
        // a metadata file whose blob is not yet present.
        await rename(tempPath, blobPath);
        const metadata: AttachmentMetadata = {
          hash: digest,
          size,
          mimeType: input.mimeType,
          name: input.name,
          ownerIdentityIds: [input.identityId],
          createdAt: new Date().toISOString(),
        };
        await this.#writeMetadata(metaPath, metadata);
        return {
          hash: digest,
          size,
          mimeType: input.mimeType,
          name: input.name,
        };
      });
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  // Reads a blob back, scoped to the requesting identity: an attachment that
  // exists but is not owned by this identity is indistinguishable from a missing
  // one, so a caller can never probe for another identity's uploads.
  async get(
    hash: string,
    identityId: string,
  ): Promise<AttachmentReadResult | undefined> {
    if (!SHA256_HEX.test(hash)) return undefined;
    const metadata = await this.#readMetadata(hash);
    if (!metadata) return undefined;
    if (!metadata.ownerIdentityIds.includes(identityId)) return undefined;
    const path = this.#blobPath(hash);
    if (!(await blobIsPresent(path))) return undefined;
    return { metadata, path };
  }

  #shardDir(hash: string): string {
    return join(this.#root, hash.slice(0, 2));
  }

  #blobPath(hash: string): string {
    return join(this.#shardDir(hash), hash);
  }

  #metadataPath(hash: string): string {
    return join(this.#shardDir(hash), `${hash}.json`);
  }

  async #readMetadata(hash: string): Promise<AttachmentMetadata | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#metadataPath(hash), "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    return AttachmentMetadataSchema.parse(JSON.parse(raw));
  }

  async #writeMetadata(
    path: string,
    metadata: AttachmentMetadata,
  ): Promise<void> {
    // Called from inside the metaPath's managed-write critical section, so this
    // only needs the atomic temp-then-rename primitive, not the lock itself.
    await atomicWriteInPlace(path, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

function throwWriterOutcome(outcome: WriterOutcome): never {
  if (!outcome.ok) throw outcome.error;
  throw new Error("attachment staging writer closed before the upload ended");
}

async function blobIsPresent(blobPath: string): Promise<boolean> {
  try {
    return (await stat(blobPath)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function addOwner(owners: readonly string[], identityId: string): string[] {
  if (owners.includes(identityId)) return [...owners];
  return [...owners, identityId];
}
