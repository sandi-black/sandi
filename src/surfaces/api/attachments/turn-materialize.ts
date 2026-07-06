import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod/v4";
import type { AttachmentStore } from "@/surfaces/api/attachments/store";

// A turn's attachment refs name blobs already in the store; the provider needs
// real files on disk (so pi's `@file` mechanism and, eventually, any local tool
// can read them), so each ref is copied out into a directory scoped to this one
// turn. The directory is removed in the turn's finally, so no attachment ever
// outlives the turn that requested it.

// A ref's hash must be the store's own canonical shape (64 lowercase hex): a
// well-formed but non-canonical hash (uppercase, short) can never match a
// stored blob, so rejecting it here at the turn-body boundary gives the caller
// a clear invalid_attachments rather than a confusing not-found later. Owned
// here (not api-bot.ts) so the wire shape and the materializer share one
// definition of what a ref is.
const ATTACHMENT_HASH = /^[0-9a-f]{64}$/;
export const AttachmentRefSchema = z.object({
  hash: z
    .string()
    .regex(ATTACHMENT_HASH, "hash must be 64 lowercase hex chars"),
  // The override name becomes a materialized file's basename, so it is bound
  // to a single filename at the wire boundary; sanitizeFileName below stays
  // as defense in depth for the stored name path.
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) => !value.includes("/") && !value.includes("\\"),
      "name must be a single filename, not a path",
    )
    .optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

// A turn body may reference at most this many attachments; beyond this it is
// almost certainly a mistake (or abuse), and materializing each ref costs a
// store lookup and a file copy, so the cap keeps a single turn bounded.
export const MAX_TURN_ATTACHMENTS = 16;
export const AttachmentRefsSchema = z
  .array(AttachmentRefSchema)
  .max(MAX_TURN_ATTACHMENTS);

export class InvalidAttachmentRefError extends Error {
  readonly hash: string;
  constructor(hash: string) {
    // The message never echoes anything about the ref beyond the hash itself
    // (no stored name, no owner info): the hash is what the caller supplied, so
    // it is already known to them, but nothing else about the attachment leaks
    // to a caller who does not own it.
    super(`attachment not found or not owned: ${hash}`);
    this.name = "InvalidAttachmentRefError";
    this.hash = hash;
  }
}

// Creates a fresh temp directory, copies each ref's blob into it under a safe
// name, and returns the absolute paths in ref order. Throws
// InvalidAttachmentRefError (naming only the offending hash) the first time a
// ref does not resolve for this identity, and cleans up any directory it
// already created before throwing.
export async function materializeAttachmentRefs(input: {
  store: AttachmentStore;
  identityId: string;
  refs: readonly AttachmentRef[];
}): Promise<{ dir: string | undefined; paths: string[] }> {
  if (input.refs.length === 0) return { dir: undefined, paths: [] };

  const dir = await mkdtemp(join(tmpdir(), "sandi-turn-attachments-"));
  try {
    const usedNames = new Set<string>();
    const paths: string[] = [];
    for (const ref of input.refs) {
      const found = await input.store.get(ref.hash, input.identityId);
      if (!found) throw new InvalidAttachmentRefError(ref.hash);
      const preferredName = ref.name?.trim() || found.metadata.name;
      const safeName = dedupeName(usedNames, sanitizeFileName(preferredName));
      usedNames.add(safeName);
      const destination = join(dir, safeName);
      await copyFile(found.path, destination);
      paths.push(destination);
    }
    return { dir, paths };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupMaterializedAttachments(
  dir: string | undefined,
): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}

// Strips path separators and traversal segments from a stored or caller-given
// name so it is safe to join under the temp directory. Falls back to a generic
// name if stripping empties it out entirely (e.g. a name that was only slashes).
function sanitizeFileName(name: string): string {
  const base = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .pop();
  const trimmed = base?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "attachment";
}

// Two refs can resolve to the same display name (the same file uploaded twice
// under different hashes, or two refs overriding to the same name); suffix the
// later one so no materialized file silently overwrites an earlier one.
function dedupeName(used: ReadonlySet<string>, name: string): string {
  if (!used.has(name)) return name;
  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : "";
  let counter = 2;
  let candidate = `${stem} (${counter})${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem} (${counter})${ext}`;
  }
  return candidate;
}
