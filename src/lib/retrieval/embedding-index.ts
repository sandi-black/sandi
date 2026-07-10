import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { isMissingFileError } from "../fs-errors";
import {
  createEmbeddingEngineFromEnv,
  type EmbeddingEngine,
  type EmbeddingEngineStatus,
} from "./embeddings";
import type { SearchPassage } from "./parent-search";
import { z } from "zod/v4";

export const EMBEDDING_INDEX_VERSION = 1;

export type EmbeddingIndexKind = "skills" | "memory";

export type EmbeddingIndexSourceFile = {
  sourcePath: string;
  absolutePath: string;
  content: string;
};

export type IndexedSearchPassage = SearchPassage & {
  sourcePath: string;
  embedding: number[];
};

export type EmbeddingIndexManifest = {
  version: number;
  kind: EmbeddingIndexKind;
  generation: string;
  contentHash: string;
  embeddingEngine: string;
  createdAt: string;
  sourceFileCount: number;
  passageCount: number;
};

export type CachedEmbeddingIndex = {
  manifest: EmbeddingIndexManifest;
  passages: IndexedSearchPassage[];
};

export type RebuildEmbeddingIndexResult =
  | {
      rebuilt: true;
      manifest: EmbeddingIndexManifest;
    }
  | {
      rebuilt: false;
      embedding: EmbeddingEngineStatus;
    };

type CurrentPointer = {
  generation: string;
};

type WriteIndexInput = {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
  contentHash: string;
  sourceFileCount: number;
  passages: IndexedSearchPassage[];
  embeddingEngine: string;
};

const CURRENT_POINTER_SCHEMA = z.object({
  generation: z.string().min(1),
});

const INDEX_KIND_SCHEMA = z.enum(["skills", "memory"]);

const INDEX_MANIFEST_SCHEMA = z.object({
  version: z.number().int(),
  kind: INDEX_KIND_SCHEMA,
  generation: z.string().min(1),
  contentHash: z.string().min(1),
  embeddingEngine: z.string().min(1),
  createdAt: z.string().min(1),
  sourceFileCount: z.number().int().nonnegative(),
  passageCount: z.number().int().nonnegative(),
});

const INDEXED_PASSAGE_SCHEMA = z.object({
  parentId: z.string(),
  passageId: z.string(),
  content: z.string(),
  label: z.string().optional(),
  weight: z.number().optional(),
  sourcePath: z.string(),
  embedding: z.array(z.number()),
});

const INDEX_FILE_SCHEMA = z.object({
  passages: z.array(INDEXED_PASSAGE_SCHEMA),
});

const LOADED_INDEX_CACHE = new Map<
  string,
  { generation: string; index: CachedEmbeddingIndex }
>();
const STALE_TMP_GENERATION_MS = 60 * 60 * 1_000;

export function embeddingIndexCacheRoot(dataDir: string): string {
  return join(dataDir, "cache", "embeddings");
}

export function embeddingIndexCacheRootForSourceRoot(
  sourceRoot: string,
  sourceRootName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataDir = env["SANDI_DATA_DIR"]?.trim();
  if (dataDir) return embeddingIndexCacheRoot(resolve(dataDir));
  const resolved = resolve(sourceRoot);
  if (basename(resolved) === sourceRootName) {
    return embeddingIndexCacheRoot(dirname(resolved));
  }
  return embeddingIndexCacheRoot(resolve("./data"));
}

export function contentHashForSourceFiles(
  files: readonly EmbeddingIndexSourceFile[],
): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) =>
    a.sourcePath.localeCompare(b.sourcePath),
  );
  for (const file of sorted) {
    hash.update(file.sourcePath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function rebuildCachedEmbeddingIndex(input: {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
  contentHash: string;
  sourceFileCount: number;
  passages: readonly (SearchPassage & { sourcePath: string })[];
  embeddingEngine?: EmbeddingEngine | null | undefined;
}): Promise<RebuildEmbeddingIndexResult> {
  const engine =
    input.embeddingEngine === undefined
      ? createEmbeddingEngineFromEnv()
      : input.embeddingEngine;
  if (!engine) {
    return {
      rebuilt: false,
      embedding: { available: false, reason: "embedding provider disabled" },
    };
  }

  const embeddings = await engine.embed(
    input.passages.map((passage) => passage.content),
  );
  const indexedPassages: IndexedSearchPassage[] = [];
  for (const [index, passage] of input.passages.entries()) {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`Embedding missing for ${input.kind} passage ${index}`);
    }
    indexedPassages.push(indexedPassage(passage, embedding));
  }

  const manifest = await writeEmbeddingIndex({
    kind: input.kind,
    cacheRoot: input.cacheRoot,
    contentHash: input.contentHash,
    sourceFileCount: input.sourceFileCount,
    passages: indexedPassages,
    embeddingEngine: engine.name,
  });
  return { rebuilt: true, manifest };
}

export async function readCurrentEmbeddingIndexManifest(input: {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
}): Promise<EmbeddingIndexManifest | null> {
  const pointer = await readCurrentPointer(input);
  if (!pointer) return null;
  return await readManifest(input.kind, input.cacheRoot, pointer.generation);
}

export async function loadCurrentEmbeddingIndex(input: {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
}): Promise<CachedEmbeddingIndex | null> {
  const pointer = await readCurrentPointer(input);
  if (!pointer) return null;

  const cacheKey = currentPointerPath(input.kind, input.cacheRoot);
  const cached = LOADED_INDEX_CACHE.get(cacheKey);
  if (cached?.generation === pointer.generation) return cached.index;

  const manifest = await readManifest(
    input.kind,
    input.cacheRoot,
    pointer.generation,
  );
  if (!manifest || manifest.version !== EMBEDDING_INDEX_VERSION) return null;

  const rawIndex = await readJsonIfExists(
    indexFilePath(input.kind, input.cacheRoot, pointer.generation),
  );
  if (!rawIndex) return null;
  const parsed = INDEX_FILE_SCHEMA.parse(rawIndex);
  const index: CachedEmbeddingIndex = {
    manifest,
    passages: parsed.passages.map(indexedPassageFromDisk),
  };
  LOADED_INDEX_CACHE.set(cacheKey, { generation: pointer.generation, index });
  return index;
}

export async function cleanupOldEmbeddingIndexGenerations(input: {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
  currentGeneration: string;
  keepCount?: number | undefined;
}): Promise<void> {
  const generationsRoot = generationsPath(input.kind, input.cacheRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(generationsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const keepCount = input.keepCount ?? 2;
  const generationNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-"))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  const keep = new Set([
    input.currentGeneration,
    ...generationNames.slice(0, keepCount),
  ]);
  const nowMs = Date.now();

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      if (keep.has(entry.name)) return;
      if (
        !entry.name.includes(".tmp-") &&
        generationNames.includes(entry.name)
      ) {
        await rm(join(generationsRoot, entry.name), {
          recursive: true,
          force: true,
        });
        return;
      }
      if (entry.name.includes(".tmp-")) {
        await cleanupStaleTmpGeneration(generationsRoot, entry.name, nowMs);
      }
    }),
  );
}

async function cleanupStaleTmpGeneration(
  generationsRoot: string,
  generationName: string,
  nowMs: number,
): Promise<void> {
  const path = join(generationsRoot, generationName);
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (nowMs - info.mtimeMs < STALE_TMP_GENERATION_MS) return;
  await rm(path, { recursive: true, force: true });
}

/**
 * Narrows a cached generation's passages down to only the source files still
 * present in the caller's current listing (a file deleted since the index
 * was built should not surface stale search results), and to metadata-only
 * passages when the caller only wants the lighter-weight summary form.
 * Shared verbatim by skill and memory hybrid search, which otherwise
 * duplicated this filter identically.
 */
export function filterIndexedPassagesForSearch(
  passages: readonly IndexedSearchPassage[],
  sourcePaths: ReadonlySet<string>,
  mode: "passages" | "metadata" | undefined,
): IndexedSearchPassage[] {
  return passages.filter(
    (passage) =>
      sourcePaths.has(passage.sourcePath) &&
      (mode !== "metadata" || passage.passageId.startsWith("metadata-")),
  );
}

export async function readSourceFiles(input: {
  root: string;
  includeFile(filePath: string): boolean;
}): Promise<EmbeddingIndexSourceFile[]> {
  const files: EmbeddingIndexSourceFile[] = [];
  await collectSourceFiles(input.root, input.root, input.includeFile, files);
  files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return files;
}

async function writeEmbeddingIndex(
  input: WriteIndexInput,
): Promise<EmbeddingIndexManifest> {
  const generation = generationName();
  const createdAt = new Date().toISOString();
  const manifest: EmbeddingIndexManifest = {
    version: EMBEDDING_INDEX_VERSION,
    kind: input.kind,
    generation,
    contentHash: input.contentHash,
    embeddingEngine: input.embeddingEngine,
    createdAt,
    sourceFileCount: input.sourceFileCount,
    passageCount: input.passages.length,
  };

  const indexRoot = indexRootPath(input.kind, input.cacheRoot);
  const generationsRoot = generationsPath(input.kind, input.cacheRoot);
  const tmpGeneration = `${generation}.tmp-${randomUUID()}`;
  const tmpDir = join(generationsRoot, tmpGeneration);
  const finalDir = generationPath(input.kind, input.cacheRoot, generation);
  await mkdir(tmpDir, { recursive: true });
  await writeJson(join(tmpDir, "manifest.json"), manifest);
  await writeJson(join(tmpDir, "index.json"), { passages: input.passages });
  await rename(tmpDir, finalDir);
  await mkdir(indexRoot, { recursive: true });
  await writeJsonAtomic(currentPointerPath(input.kind, input.cacheRoot), {
    generation,
  });
  await cleanupOldEmbeddingIndexGenerations({
    kind: input.kind,
    cacheRoot: input.cacheRoot,
    currentGeneration: generation,
  });
  return manifest;
}

async function readCurrentPointer(input: {
  kind: EmbeddingIndexKind;
  cacheRoot: string;
}): Promise<CurrentPointer | null> {
  const raw = await readJsonIfExists(
    currentPointerPath(input.kind, input.cacheRoot),
  );
  if (!raw) return null;
  return CURRENT_POINTER_SCHEMA.parse(raw);
}

async function readManifest(
  kind: EmbeddingIndexKind,
  cacheRoot: string,
  generation: string,
): Promise<EmbeddingIndexManifest | null> {
  const raw = await readJsonIfExists(
    manifestFilePath(kind, cacheRoot, generation),
  );
  if (!raw) return null;
  const manifest = INDEX_MANIFEST_SCHEMA.parse(raw);
  if (manifest.kind !== kind) return null;
  return manifest;
}

async function collectSourceFiles(
  root: string,
  dir: string,
  includeFile: (filePath: string) => boolean,
  files: EmbeddingIndexSourceFile[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(root, absolutePath, includeFile, files);
      continue;
    }
    if (!entry.isFile() || !includeFile(normalizedPath(absolutePath))) {
      continue;
    }
    const sourcePath = relativeSourcePath(root, absolutePath);
    files.push({
      sourcePath,
      absolutePath,
      content: await readFile(absolutePath, "utf8"),
    });
  }
}

function indexedPassage(
  passage: SearchPassage & { sourcePath: string },
  embedding: number[],
): IndexedSearchPassage {
  const indexed: IndexedSearchPassage = {
    parentId: passage.parentId,
    passageId: passage.passageId,
    content: passage.content,
    sourcePath: passage.sourcePath,
    embedding,
  };
  if (passage.label !== undefined) indexed.label = passage.label;
  if (passage.weight !== undefined) indexed.weight = passage.weight;
  return indexed;
}

function indexedPassageFromDisk(
  passage: z.infer<typeof INDEXED_PASSAGE_SCHEMA>,
): IndexedSearchPassage {
  return indexedPassage(passage, passage.embedding);
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeJson(tmpPath, value);
  await rename(tmpPath, path);
}

function currentPointerPath(
  kind: EmbeddingIndexKind,
  cacheRoot: string,
): string {
  return join(indexRootPath(kind, cacheRoot), "current.json");
}

function indexRootPath(kind: EmbeddingIndexKind, cacheRoot: string): string {
  return join(cacheRoot, kind);
}

function generationsPath(kind: EmbeddingIndexKind, cacheRoot: string): string {
  return join(indexRootPath(kind, cacheRoot), "generations");
}

function generationPath(
  kind: EmbeddingIndexKind,
  cacheRoot: string,
  generation: string,
): string {
  return join(generationsPath(kind, cacheRoot), generation);
}

function manifestFilePath(
  kind: EmbeddingIndexKind,
  cacheRoot: string,
  generation: string,
): string {
  return join(generationPath(kind, cacheRoot, generation), "manifest.json");
}

function indexFilePath(
  kind: EmbeddingIndexKind,
  cacheRoot: string,
  generation: string,
): string {
  return join(generationPath(kind, cacheRoot, generation), "index.json");
}

function generationName(): string {
  return `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
}

function relativeSourcePath(root: string, filePath: string): string {
  return normalizedPath(relative(root, filePath));
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/");
}
