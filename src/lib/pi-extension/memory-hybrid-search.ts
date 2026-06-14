import { readFile } from "node:fs/promises";

import {
  contentHashForSourceFiles,
  type EmbeddingIndexSourceFile,
  embeddingIndexCacheRootForSourceRoot,
  type IndexedSearchPassage,
  loadCurrentEmbeddingIndex,
  type RebuildEmbeddingIndexResult,
  readSourceFiles,
  rebuildCachedEmbeddingIndex,
} from "../retrieval/embedding-index";
import {
  createEmbeddingEngineFromEnv,
  type EmbeddingEngine,
} from "../retrieval/embeddings";
import type {
  HybridSearchResponse,
  HybridSearchResult,
} from "../retrieval/hybrid-search";
import {
  buildMarkdownPassages,
  parentHybridSearch,
  type SearchPassage,
} from "../retrieval/parent-search";
import {
  listAllowedRefs,
  type MemoryContext,
  parseFrontmatter,
  parseMemorySummary,
  readMemoryContext,
  readMemoryRoot,
  resolveAllowedRef,
} from "./memory-common";
import { formatSearchSignals } from "./skill-hybrid-search";

export type MemoryHybridSearchResult = {
  ref: string;
  summary: string | null;
  score: number;
  bm25Score: number;
  embeddingScore: number | null;
  matchedBy: HybridSearchResult["matchedBy"];
  snippets: string[];
};

export type MemoryHybridSearchResponse = {
  results: MemoryHybridSearchResult[];
  embedding: HybridSearchResponse["embedding"];
};

export async function searchMemoryHybrid(input: {
  root: string;
  context: MemoryContext;
  query: string;
  area?: string | undefined;
  maxResults?: number | undefined;
  maxSnippets?: number | undefined;
  minScore?: number | undefined;
  minEmbeddingScore?: number | undefined;
  minBm25NormalizedScore?: number | undefined;
  lexicalMode?: "boost" | "fallback" | "disabled" | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
  contentMode?: "passages" | "metadata" | undefined;
  supportingScoreWeight?: number | undefined;
}): Promise<MemoryHybridSearchResponse> {
  const refs = await listAllowedRefs(input.root, input.context, input.area);
  const cachedResponse = await searchCachedMemoryIndex(input, refs);
  if (cachedResponse) return cachedResponse;

  const memoryFiles = await Promise.all(
    refs.map(async (ref) => {
      const content = await readFile(
        resolveAllowedRef(input.root, input.context, ref),
        "utf8",
      );
      return { ref, content };
    }),
  );
  const contentByRef = new Map(
    memoryFiles.map((memoryFile) => [memoryFile.ref, memoryFile.content]),
  );
  const response = await parentHybridSearch(
    memoryFiles.flatMap((memoryFile) =>
      buildMemorySearchPassages(
        memoryFile.ref,
        memoryFile.content,
        input.contentMode,
      ),
    ),
    input.query,
    {
      maxResults: input.maxResults,
      maxSnippets: input.maxSnippets,
      minScore: input.minScore,
      minEmbeddingScore: input.minEmbeddingScore,
      minBm25NormalizedScore: input.minBm25NormalizedScore,
      lexicalMode: input.lexicalMode,
      embeddingEngine: input.embeddingEngine,
      queryExpansion: memoryQueryExpansion(input.query),
      supportingScoreWeight: input.supportingScoreWeight,
    },
  );
  return {
    embedding: response.embedding,
    results: response.results.map((result) => {
      const content = contentByRef.get(result.id);
      if (content === undefined) {
        throw new Error(`Hybrid memory result missing content: ${result.id}`);
      }
      return {
        ref: result.id,
        summary: parseMemorySummary(content),
        score: result.score,
        bm25Score: result.bm25Score,
        embeddingScore: result.embeddingScore,
        matchedBy: result.matchedBy,
        snippets: result.snippets,
      };
    }),
  };
}

export async function memoryEmbeddingIndexSnapshot(root: string): Promise<{
  contentHash: string;
  files: EmbeddingIndexSourceFile[];
}> {
  const files = await readSourceFiles({
    root,
    includeFile: (filePath) => filePath.endsWith(".md"),
  });
  return {
    contentHash: contentHashForSourceFiles(files),
    files,
  };
}

export async function rebuildMemoryEmbeddingIndex(input: {
  root: string;
  cacheRoot?: string | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
}): Promise<RebuildEmbeddingIndexResult> {
  const snapshot = await memoryEmbeddingIndexSnapshot(input.root);
  return await rebuildCachedEmbeddingIndex({
    kind: "memory",
    cacheRoot:
      input.cacheRoot ??
      embeddingIndexCacheRootForSourceRoot(input.root, "memory"),
    contentHash: snapshot.contentHash,
    sourceFileCount: snapshot.files.length,
    passages: memoryIndexPassages(snapshot.files),
    embeddingEngine: input.embeddingEngine,
  });
}

async function searchCachedMemoryIndex(
  input: Parameters<typeof searchMemoryHybrid>[0],
  refs: string[],
): Promise<MemoryHybridSearchResponse | null> {
  const cached = await loadCurrentEmbeddingIndex({
    kind: "memory",
    cacheRoot: embeddingIndexCacheRootForSourceRoot(input.root, "memory"),
  });
  if (!cached) return null;
  const embeddingEngine =
    input.embeddingEngine === undefined
      ? createEmbeddingEngineFromEnv()
      : input.embeddingEngine;
  if (
    embeddingEngine &&
    cached.manifest.embeddingEngine !== embeddingEngine.name
  )
    return null;

  const allowedRefs = new Set(refs);
  const passages = filterIndexedPassagesForSearch(
    cached.passages,
    allowedRefs,
    input.contentMode,
  );
  if (passages.length === 0) return null;

  const response = await parentHybridSearch(passages, input.query, {
    maxResults: input.maxResults,
    maxSnippets: input.maxSnippets,
    minScore: input.minScore,
    minEmbeddingScore: input.minEmbeddingScore,
    minBm25NormalizedScore: input.minBm25NormalizedScore,
    lexicalMode: input.lexicalMode,
    embeddingEngine,
    queryExpansion: memoryQueryExpansion(input.query),
    supportingScoreWeight: input.supportingScoreWeight,
  });
  return {
    embedding: response.embedding,
    results: await Promise.all(
      response.results.map(async (result) => {
        const content = await readFile(
          resolveAllowedRef(input.root, input.context, result.id),
          "utf8",
        );
        return {
          ref: result.id,
          summary: parseMemorySummary(content),
          score: result.score,
          bm25Score: result.bm25Score,
          embeddingScore: result.embeddingScore,
          matchedBy: result.matchedBy,
          snippets: result.snippets,
        };
      }),
    ),
  };
}

function memoryQueryExpansion(query: string): string | undefined {
  const normalized = query.toLowerCase();
  const expansions: string[] = [];
  if (
    normalized.includes("note:") ||
    normalized.includes("always") ||
    normalized.includes("usually") ||
    normalized.includes("what did we decide") ||
    normalized.includes("remember") ||
    normalized.includes("previous") ||
    normalized.includes("before") ||
    normalized.includes("preference") ||
    normalized.includes("prefer") ||
    normalized.includes("for the future")
  ) {
    expansions.push("memory recall prior context preferences decisions");
  }
  if (
    normalized.includes("todo") ||
    normalized.includes("to do") ||
    normalized.includes("task") ||
    normalized.includes("add to my list") ||
    normalized.includes("remind me") ||
    normalized.includes("appointment") ||
    normalized.includes("appt")
  ) {
    expansions.push("todo list reminders tasks household capture preferences");
  }
  return expansions.length > 0 ? expansions.join("\n") : undefined;
}

export function buildMemorySearchPassages(
  ref: string,
  content: string,
  mode: "passages" | "metadata" | undefined,
): ReturnType<typeof buildMarkdownPassages> {
  const metadata = {
    content: memoryMetadataContent(ref, content),
    label: "metadata",
    weight: 1.12,
  };
  if (mode === "metadata") {
    return [
      {
        parentId: ref,
        passageId: "metadata-1",
        content: metadata.content,
        label: metadata.label,
        weight: metadata.weight,
      },
    ];
  }
  return buildMarkdownPassages({
    parentId: ref,
    metadata: [metadata],
    markdown: content,
  });
}

function memoryIndexPassages(
  files: readonly EmbeddingIndexSourceFile[],
): (SearchPassage & { sourcePath: string })[] {
  return files.flatMap((file) =>
    buildMemorySearchPassages(file.sourcePath, file.content, undefined).map(
      (passage) => ({
        ...passage,
        sourcePath: file.sourcePath,
      }),
    ),
  );
}

function filterIndexedPassagesForSearch(
  passages: readonly IndexedSearchPassage[],
  refs: ReadonlySet<string>,
  mode: "passages" | "metadata" | undefined,
): IndexedSearchPassage[] {
  return passages.filter(
    (passage) =>
      refs.has(passage.sourcePath) &&
      (mode !== "metadata" || passage.passageId.startsWith("metadata-")),
  );
}

function memoryMetadataContent(ref: string, content: string): string {
  const parsed = parseFrontmatter(content);
  const preview = parsed.summary
    ? ""
    : parsed.body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 8)
        .join("\n")
        .slice(0, 1000);
  return [
    `ref: ${ref}`,
    parsed.summary ? `summary: ${parsed.summary}` : "",
    preview ? `preview: ${preview}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function searchCurrentMemoryHybrid(input: {
  query: string;
  area?: string | undefined;
  maxResults?: number | undefined;
  maxSnippets?: number | undefined;
  minScore?: number | undefined;
  minEmbeddingScore?: number | undefined;
  minBm25NormalizedScore?: number | undefined;
  lexicalMode?: "boost" | "fallback" | "disabled" | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
  contentMode?: "passages" | "metadata" | undefined;
  supportingScoreWeight?: number | undefined;
}): Promise<MemoryHybridSearchResponse> {
  return await searchMemoryHybrid({
    root: readMemoryRoot(),
    context: readMemoryContext(),
    query: input.query,
    area: input.area,
    maxResults: input.maxResults,
    maxSnippets: input.maxSnippets,
    minScore: input.minScore,
    minEmbeddingScore: input.minEmbeddingScore,
    minBm25NormalizedScore: input.minBm25NormalizedScore,
    lexicalMode: input.lexicalMode,
    embeddingEngine: input.embeddingEngine,
    contentMode: input.contentMode,
    supportingScoreWeight: input.supportingScoreWeight,
  });
}

export function formatMemoryHybridResult(
  result: MemoryHybridSearchResult,
): string {
  const summary = result.summary ? `: ${result.summary}` : "";
  return [
    `- ${result.ref} (${formatSearchSignals(result)})${summary}`,
    ...result.snippets.map((snippet) => `  ${snippet}`),
  ].join("\n");
}
