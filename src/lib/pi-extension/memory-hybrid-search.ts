import { readFile } from "node:fs/promises";

import type { EmbeddingEngine } from "../retrieval/embeddings";
import type {
  HybridSearchResponse,
  HybridSearchResult,
} from "../retrieval/hybrid-search";
import {
  buildMarkdownPassages,
  parentHybridSearch,
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
      memorySearchPassages(
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

function memorySearchPassages(
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
