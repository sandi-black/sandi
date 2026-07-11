import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { withTempDir } from "@/lib/verification/harness";
import { cleanupAttachmentStore } from "@/surfaces/api/attachments/cleanup";
import {
  AttachmentQuotaExceededError,
  AttachmentStore,
} from "@/surfaces/api/attachments/store";

await withTempDir("sandi-attachment-cleanup-", async (root) => {
  await verifyQuotaAndDedup(join(root, "quota"));
  await verifyCleanup(join(root, "cleanup"));
});

async function verifyQuotaAndDedup(root: string): Promise<void> {
  const store = new AttachmentStore(root, { quotaBytes: 4 });
  const first = await upload(store, Buffer.from("Ada!"), "ada", "first.bin");
  const duplicate = await upload(
    store,
    Buffer.from("Ada!"),
    "ada",
    "duplicate.bin",
  );
  equal(
    duplicate.hash,
    first.hash,
    "same-owner dedup does not spend quota twice",
  );
  await rejects(
    upload(store, Buffer.from("x"), "ada", "overflow.bin"),
    AttachmentQuotaExceededError,
  );
  await upload(store, Buffer.from("Ada!"), "grace", "shared.bin");

  const concurrent = new AttachmentStore(join(root, "concurrent"), {
    quotaBytes: 4,
  });
  const results = await Promise.allSettled([
    upload(concurrent, Buffer.from("111"), "anna", "one.bin"),
    upload(concurrent, Buffer.from("222"), "anna", "two.bin"),
  ]);
  equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    "concurrent uploads admit only one result within quota",
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert(
    rejected?.status === "rejected" &&
      rejected.reason instanceof AttachmentQuotaExceededError,
    "the concurrent overflow returns AttachmentQuotaExceededError",
  );
  console.log("ok per-identity quota is serialized and dedup-aware");
}

async function verifyCleanup(root: string): Promise<void> {
  const store = new AttachmentStore(root);
  const retained = await upload(
    store,
    Buffer.from("retained"),
    "ada",
    "retained.bin",
  );
  const pinned = await upload(
    store,
    Buffer.from("pinned"),
    "ada",
    "pinned.bin",
  );
  equal(await store.setPinned(pinned.hash, "ada", true), true);
  const expired = await upload(
    store,
    Buffer.from("expired"),
    "ada",
    "expired.bin",
  );
  const reRetained = await upload(
    store,
    Buffer.from("re-retained"),
    "ada",
    "re-retained.bin",
  );
  const missingBlob = await upload(
    store,
    Buffer.from("missing"),
    "ada",
    "missing.bin",
  );
  await rm(blobPath(root, missingBlob.hash));

  const old = new Date("2026-01-01T00:00:00.000Z");
  const orphanHash = "a".repeat(64);
  const malformedHash = "b".repeat(64);
  await mkdir(join(root, "aa"), { recursive: true });
  await writeFile(blobPath(root, orphanHash), "orphan");
  await utimes(blobPath(root, orphanHash), old, old);
  await mkdir(join(root, "bb"), { recursive: true });
  await writeFile(blobPath(root, malformedHash), "malformed");
  await writeFile(metadataPath(root, malformedHash), "{not json");
  await utimes(blobPath(root, malformedHash), old, old);
  await utimes(metadataPath(root, malformedHash), old, old);
  await mkdir(join(root, "_staging"), { recursive: true });
  const interrupted = join(root, "_staging", "interrupted.tmp");
  await writeFile(interrupted, "partial");
  await utimes(interrupted, old, old);

  const firstRunAt = new Date("2026-03-01T00:00:00.000Z");
  const first = await cleanupAttachmentStore({
    root,
    retainedHashes: new Set([retained.hash]),
    retentionMs: 30 * 24 * 60 * 60 * 1_000,
    now: firstRunAt,
  });
  equal(first.deletedStagingFiles, 1);
  equal(first.malformedMetadata, 1);
  equal(await exists(blobPath(root, retained.hash)), true);
  equal(await exists(blobPath(root, pinned.hash)), true);
  equal(await exists(blobPath(root, expired.hash)), true);
  const expiredMetadata = JSON.parse(
    await readFile(metadataPath(root, expired.hash), "utf8"),
  );
  equal(expiredMetadata.unreferencedSince, firstRunAt.toISOString());

  const second = await cleanupAttachmentStore({
    root,
    retainedHashes: new Set([retained.hash, reRetained.hash]),
    retentionMs: 30 * 24 * 60 * 60 * 1_000,
    now: new Date("2026-04-01T00:00:00.000Z"),
  });
  assert(second.reclaimedBytes > 0, "cleanup reports reclaimed bytes");
  assert(
    first.deletedBlobs + second.deletedBlobs >= 3,
    "expired and orphan blobs are deleted",
  );
  equal(await exists(blobPath(root, retained.hash)), true);
  equal(await exists(blobPath(root, pinned.hash)), true);
  equal(await exists(blobPath(root, expired.hash)), false);
  equal(await exists(metadataPath(root, missingBlob.hash)), false);
  const reRetainedMetadata = JSON.parse(
    await readFile(metadataPath(root, reRetained.hash), "utf8"),
  );
  equal(reRetainedMetadata.unreferencedSince, undefined);

  const repeated = await cleanupAttachmentStore({
    root,
    retainedHashes: new Set([retained.hash, reRetained.hash]),
    retentionMs: 30 * 24 * 60 * 60 * 1_000,
    now: new Date("2026-04-01T00:00:00.000Z"),
  });
  equal(repeated.reclaimedBytes, 0);
  equal(repeated.deletedBlobs, 0);
  console.log(
    "ok cleanup is idempotent across retained, pinned, expired, malformed, missing, and interrupted records",
  );
}

function upload(
  store: AttachmentStore,
  bytes: Buffer,
  identityId: string,
  name: string,
) {
  return store.upload({
    body: Readable.from([bytes]),
    mimeType: "application/octet-stream",
    name,
    identityId,
  });
}

function blobPath(root: string, hash: string): string {
  return join(root, hash.slice(0, 2), hash);
}

function metadataPath(root: string, hash: string): string {
  return `${blobPath(root, hash)}.json`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rejects(
  promise: Promise<unknown>,
  errorType: typeof AttachmentQuotaExceededError,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorType) return;
    throw error;
  }
  throw new Error(`expected ${errorType.name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

console.log("attachment quota and cleanup verification passed");
