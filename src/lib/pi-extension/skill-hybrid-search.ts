import { readFile } from "node:fs/promises";
import { relative } from "node:path";

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
  type ParentSearchResult,
  parentHybridSearch,
  type SearchPassage,
} from "../retrieval/parent-search";
import {
  formatSkillSource,
  listResolvedSkills,
  parseSkillMetadata,
  type ResolvedSkill,
  type SkillSource,
} from "./skill-common";

export type SkillHybridSearchResult = {
  name: string;
  description: string | null;
  source: SkillSource;
  score: number;
  bm25Score: number;
  embeddingScore: number | null;
  matchedBy: HybridSearchResult["matchedBy"];
  snippets: string[];
};

export type SkillHybridSearchResponse = {
  results: SkillHybridSearchResult[];
  embedding: HybridSearchResponse["embedding"];
};

export async function searchSkillsHybrid(input: {
  root: string;
  surface?: string | null;
  query: string;
  maxResults?: number | undefined;
  maxSnippets?: number | undefined;
  minScore?: number | undefined;
  minEmbeddingScore?: number | undefined;
  minBm25NormalizedScore?: number | undefined;
  lexicalMode?: "boost" | "fallback" | "disabled" | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
  contentMode?: "passages" | "metadata" | undefined;
  supportingScoreWeight?: number | undefined;
}): Promise<SkillHybridSearchResponse> {
  const skills = await listResolvedSkills({
    root: input.root,
    surface: input.surface ?? null,
  });
  const metadataByName = new Map(skills.map((skill) => [skill.name, skill]));
  const cachedResponse = await searchCachedSkillIndex(input, skills);
  if (cachedResponse) return cachedResponse;

  const documentGroups = await Promise.all(
    skills.map(async (skill) => {
      const fullContent = await readFile(skill.filePath, "utf8");
      return buildSkillSearchPassages(skill, fullContent, input.contentMode);
    }),
  );
  const response = await parentHybridSearch(
    documentGroups.flat(),
    input.query,
    {
      maxResults: input.maxResults,
      maxSnippets: input.maxSnippets,
      minScore: input.minScore,
      minEmbeddingScore: input.minEmbeddingScore,
      minBm25NormalizedScore: input.minBm25NormalizedScore,
      lexicalMode: input.lexicalMode,
      embeddingEngine: input.embeddingEngine,
      queryExpansion: skillQueryExpansion(input.query),
      supportingScoreWeight: input.supportingScoreWeight,
    },
  );
  return {
    embedding: response.embedding,
    results: response.results.map((result) =>
      skillSearchResult(result, metadataByName),
    ),
  };
}

export async function skillEmbeddingIndexSnapshot(root: string): Promise<{
  contentHash: string;
  files: EmbeddingIndexSourceFile[];
}> {
  const files = await readSourceFiles({
    root,
    includeFile: (filePath) => filePath.endsWith("/SKILL.md"),
  });
  return {
    contentHash: contentHashForSourceFiles(files),
    files,
  };
}

export async function rebuildSkillEmbeddingIndex(input: {
  root: string;
  cacheRoot?: string | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
}): Promise<RebuildEmbeddingIndexResult> {
  const snapshot = await skillEmbeddingIndexSnapshot(input.root);
  return await rebuildCachedEmbeddingIndex({
    kind: "skills",
    cacheRoot:
      input.cacheRoot ??
      embeddingIndexCacheRootForSourceRoot(input.root, "skills"),
    contentHash: snapshot.contentHash,
    sourceFileCount: snapshot.files.length,
    passages: skillIndexPassages(snapshot.files),
    embeddingEngine: input.embeddingEngine,
  });
}

async function searchCachedSkillIndex(
  input: Parameters<typeof searchSkillsHybrid>[0],
  skills: ResolvedSkill[],
): Promise<SkillHybridSearchResponse | null> {
  const cached = await loadCurrentEmbeddingIndex({
    kind: "skills",
    cacheRoot: embeddingIndexCacheRootForSourceRoot(input.root, "skills"),
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

  const effectiveSourcePaths = new Set(
    skills.map((skill) => sourcePathForFile(input.root, skill.filePath)),
  );
  const passages = filterIndexedPassagesForSearch(
    cached.passages,
    effectiveSourcePaths,
    input.contentMode,
  );
  if (passages.length === 0) return null;

  const metadataByName = new Map(skills.map((skill) => [skill.name, skill]));
  const response = await parentHybridSearch(passages, input.query, {
    maxResults: input.maxResults,
    maxSnippets: input.maxSnippets,
    minScore: input.minScore,
    minEmbeddingScore: input.minEmbeddingScore,
    minBm25NormalizedScore: input.minBm25NormalizedScore,
    lexicalMode: input.lexicalMode,
    embeddingEngine,
    queryExpansion: skillQueryExpansion(input.query),
    supportingScoreWeight: input.supportingScoreWeight,
  });
  return {
    embedding: response.embedding,
    results: response.results.map((result) =>
      skillSearchResult(result, metadataByName),
    ),
  };
}

function skillQueryExpansion(query: string): string | undefined {
  const normalized = query.toLowerCase();
  const expansions: string[] = [];
  if (
    normalized.includes("http://") ||
    normalized.includes("https://") ||
    normalized.includes("tweet") ||
    normalized.includes("tweets") ||
    normalized.includes("read about") ||
    normalized.includes("research") ||
    normalized.includes("investigate") ||
    normalized.includes("source") ||
    normalized.includes("sources") ||
    normalized.includes("docs") ||
    normalized.includes("documentation") ||
    normalized.includes("current") ||
    normalized.includes("latest") ||
    normalized.includes("google") ||
    normalized.includes("look this up") ||
    normalized.includes("look up") ||
    normalized.includes("look into") ||
    normalized.includes("find out")
  ) {
    expansions.push("search research web sources verify current facts");
  }
  if (
    normalized.includes("todo") ||
    normalized.includes("to do") ||
    normalized.includes("task") ||
    normalized.includes("tasks") ||
    normalized.includes("add to my list") ||
    normalized.includes("remember to") ||
    normalized.includes("appointment") ||
    normalized.includes("appt") ||
    normalized.includes("remind") ||
    normalized.includes("ping me") ||
    normalized.includes("follow up") ||
    normalized.includes("tomorrow") ||
    normalized.includes("next week")
  ) {
    expansions.push("todo list reminder schedule follow-up task capture later");
  }
  return expansions.length > 0 ? expansions.join("\n") : undefined;
}

function skillSearchResult(
  result: ParentSearchResult,
  metadataByName: Map<string, ResolvedSkill>,
): SkillHybridSearchResult {
  const skill = metadataByName.get(result.id);
  if (!skill) {
    throw new Error(`Hybrid skill result missing metadata: ${result.id}`);
  }
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    score: result.score,
    bm25Score: result.bm25Score,
    embeddingScore: result.embeddingScore,
    matchedBy: result.matchedBy,
    snippets: result.snippets,
  };
}

function skillMetadataContent(skill: {
  name: string;
  description: string | null;
  source: SkillSource;
}): string {
  return [
    `name: ${skill.name}`,
    `source: ${formatSkillSource(skill.source)}`,
    `description: ${skill.description ?? ""}`,
  ].join("\n");
}

export function buildSkillSearchPassages(
  skill: ResolvedSkill,
  fullContent: string,
  mode: "passages" | "metadata" | undefined,
): ReturnType<typeof buildMarkdownPassages> {
  const metadata = {
    content: skillMetadataContent(skill),
    label: "metadata",
    weight: 1.12,
  };
  if (mode === "metadata") {
    return [
      {
        parentId: skill.name,
        passageId: "metadata-1",
        content: metadata.content,
        label: metadata.label,
        weight: metadata.weight,
      },
    ];
  }
  return buildMarkdownPassages({
    parentId: skill.name,
    metadata: [metadata],
    markdown: fullContent,
  });
}

function skillIndexPassages(
  files: readonly EmbeddingIndexSourceFile[],
): (SearchPassage & { sourcePath: string })[] {
  return files.flatMap((file) => {
    const skill = resolvedSkillFromSourceFile(file);
    if (!skill) return [];
    return buildSkillSearchPassages(skill, file.content, undefined).map(
      (passage) => ({
        ...passage,
        sourcePath: file.sourcePath,
      }),
    );
  });
}

function resolvedSkillFromSourceFile(
  file: EmbeddingIndexSourceFile,
): ResolvedSkill | null {
  const source = skillSourceFromPath(file.sourcePath);
  if (!source) return null;
  const metadata = parseSkillMetadata(file.content);
  const fallbackName = skillNameFromSourcePath(file.sourcePath);
  if (!fallbackName) return null;
  return {
    name: metadata.name ?? fallbackName,
    description: metadata.description,
    source,
    filePath: file.absolutePath,
  };
}

function skillSourceFromPath(sourcePath: string): SkillSource | null {
  const parts = sourcePath.split("/");
  if (
    parts.length === 4 &&
    parts[0] === "core" &&
    (parts[1] === "builtin" || parts[1] === "custom") &&
    parts[3] === "SKILL.md"
  ) {
    return { scope: "core", kind: parts[1], surface: null };
  }
  if (
    parts.length === 5 &&
    parts[0] === "surfaces" &&
    (parts[2] === "builtin" || parts[2] === "custom") &&
    parts[4] === "SKILL.md"
  ) {
    return { scope: "surface", kind: parts[2], surface: parts[1] ?? null };
  }
  return null;
}

function skillNameFromSourcePath(sourcePath: string): string | null {
  const parts = sourcePath.split("/");
  if (parts.length === 4 && parts[0] === "core") return parts[2] ?? null;
  if (parts.length === 5 && parts[0] === "surfaces") return parts[3] ?? null;
  return null;
}

function filterIndexedPassagesForSearch(
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

function sourcePathForFile(root: string, filePath: string): string {
  return relative(root, filePath).replaceAll("\\", "/");
}

export function formatSkillHybridResult(
  result: SkillHybridSearchResult,
): string {
  const description = result.description
    ? `: ${result.description}`
    : ": No description.";
  return [
    `- ${result.name} (${formatSkillSource(result.source)}, ${formatSearchSignals(result)})${description}`,
    ...result.snippets.map((snippet) => `  ${snippet}`),
  ].join("\n");
}

export function formatSearchSignals(input: {
  score: number;
  bm25Score: number;
  embeddingScore: number | null;
  matchedBy: string;
}): string {
  const embedding =
    input.embeddingScore === null
      ? "embedding n/a"
      : `embedding ${input.embeddingScore.toFixed(3)}`;
  return [
    `score ${input.score.toFixed(3)}`,
    `bm25 ${input.bm25Score.toFixed(3)}`,
    embedding,
    `matched by ${input.matchedBy}`,
  ].join(", ");
}
