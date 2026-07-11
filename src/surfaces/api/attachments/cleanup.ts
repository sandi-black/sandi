import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFileError } from "@/lib/fs-errors";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";
import {
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_HOURS,
  DEFAULT_ATTACHMENT_RETENTION_DAYS,
} from "@/surfaces/api/attachments/policy";
import {
  type AttachmentMetadata,
  AttachmentMetadataSchema,
} from "@/surfaces/api/attachments/store";

export const DEFAULT_ATTACHMENT_RETENTION_MS =
  DEFAULT_ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS =
  DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;

export type AttachmentCleanupReport = {
  reclaimedBytes: number;
  deletedBlobs: number;
  deletedStagingFiles: number;
  skippedRecords: number;
  malformedMetadata: number;
};

const HASH = /^[0-9a-f]{64}$/;

export async function cleanupAttachmentStore(input: {
  root: string;
  retainedHashes: ReadonlySet<string>;
  retentionMs?: number;
  now?: Date;
}): Promise<AttachmentCleanupReport> {
  const retentionMs = input.retentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("attachment retention must be a nonnegative safe integer");
  }
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - retentionMs;
  return withManagedWrite(join(input.root, "_maintenance.json"), async () => {
    const report: AttachmentCleanupReport = {
      reclaimedBytes: 0,
      deletedBlobs: 0,
      deletedStagingFiles: 0,
      skippedRecords: 0,
      malformedMetadata: 0,
    };
    await cleanupStaging(input.root, cutoff, report);
    const shards = await directories(input.root);
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      await cleanupShard({
        root: input.root,
        shard,
        retainedHashes: input.retainedHashes,
        now,
        cutoff,
        report,
      });
    }
    return report;
  });
}

async function cleanupShard(input: {
  root: string;
  shard: string;
  retainedHashes: ReadonlySet<string>;
  now: Date;
  cutoff: number;
  report: AttachmentCleanupReport;
}): Promise<void> {
  const dir = join(input.root, input.shard);
  const names = await files(dir);
  const hashes = new Set<string>();
  for (const name of names) {
    const candidate = name.endsWith(".json")
      ? name.slice(0, -".json".length)
      : name;
    if (HASH.test(candidate)) hashes.add(candidate);
  }
  for (const hash of hashes) {
    const blobPath = join(dir, hash);
    const metadataPath = join(dir, `${hash}.json`);
    const blob = await fileStats(blobPath);
    const metadata = await readMetadata(metadataPath);
    if (metadata.kind === "malformed") input.report.malformedMetadata += 1;

    const retained = input.retainedHashes.has(hash);
    const pinned =
      metadata.kind === "valid" &&
      (metadata.value.pinnedByIdentityIds?.length ?? 0) > 0;
    if (retained || pinned) {
      if (metadata.kind === "valid" && metadata.value.unreferencedSince) {
        await writeMetadata(
          metadataPath,
          withoutUnreferencedSince(metadata.value),
        );
      } else if (metadata.kind !== "valid" || !blob) {
        input.report.skippedRecords += 1;
      }
      continue;
    }

    if (metadata.kind === "valid") {
      if (!metadata.value.unreferencedSince) {
        await writeMetadata(metadataPath, {
          ...metadata.value,
          unreferencedSince: input.now.toISOString(),
        });
        input.report.skippedRecords += 1;
        continue;
      }
      if (new Date(metadata.value.unreferencedSince).getTime() > input.cutoff) {
        input.report.skippedRecords += 1;
        continue;
      }
      await deleteRecord(blobPath, metadataPath, blob?.size ?? 0, input.report);
      continue;
    }

    const age = Math.max(
      blob?.mtimeMs ?? Number.NEGATIVE_INFINITY,
      metadata.mtimeMs ?? Number.NEGATIVE_INFINITY,
    );
    if (age > input.cutoff) {
      input.report.skippedRecords += 1;
      continue;
    }
    await deleteRecord(blobPath, metadataPath, blob?.size ?? 0, input.report);
  }
}

async function cleanupStaging(
  root: string,
  cutoff: number,
  report: AttachmentCleanupReport,
): Promise<void> {
  const dir = join(root, "_staging");
  for (const name of await files(dir)) {
    const path = join(dir, name);
    const details = await fileStats(path);
    if (!details || details.mtimeMs > cutoff) {
      report.skippedRecords += 1;
      continue;
    }
    await rm(path, { force: true });
    report.reclaimedBytes += details.size;
    report.deletedStagingFiles += 1;
  }
}

async function deleteRecord(
  blobPath: string,
  metadataPath: string,
  blobSize: number,
  report: AttachmentCleanupReport,
): Promise<void> {
  const hadBlob = blobSize > 0 || Boolean(await fileStats(blobPath));
  await rm(blobPath, { force: true });
  await rm(metadataPath, { force: true });
  if (hadBlob) report.deletedBlobs += 1;
  report.reclaimedBytes += blobSize;
}

type MetadataRead =
  | { kind: "missing"; mtimeMs?: undefined }
  | { kind: "malformed"; mtimeMs: number }
  | { kind: "valid"; value: AttachmentMetadata; mtimeMs: number };

async function readMetadata(path: string): Promise<MetadataRead> {
  try {
    const details = await stat(path);
    const parsed = AttachmentMetadataSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return parsed.success
      ? { kind: "valid", value: parsed.data, mtimeMs: details.mtimeMs }
      : { kind: "malformed", mtimeMs: details.mtimeMs };
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing" };
    if (error instanceof SyntaxError) {
      const details = await stat(path);
      return { kind: "malformed", mtimeMs: details.mtimeMs };
    }
    throw error;
  }
}

async function writeMetadata(
  path: string,
  metadata: AttachmentMetadata,
): Promise<void> {
  await atomicWriteInPlace(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

function withoutUnreferencedSince(
  metadata: AttachmentMetadata,
): AttachmentMetadata {
  const copy = { ...metadata };
  delete copy.unreferencedSince;
  return copy;
}

async function directories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function files(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function fileStats(
  path: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const details = await stat(path);
    return details.isFile()
      ? { size: details.size, mtimeMs: details.mtimeMs }
      : undefined;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}
