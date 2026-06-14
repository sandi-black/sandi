import { readFile } from "node:fs/promises";

import type { EmbeddingEngine } from "../retrieval/embeddings";
import type {
  HybridSearchResponse,
  HybridSearchResult,
} from "../retrieval/hybrid-search";
import {
  buildMarkdownPassages,
  type ParentSearchResult,
  parentHybridSearch,
} from "../retrieval/parent-search";
import {
  formatSkillSource,
  listResolvedSkills,
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
  const documentGroups = await Promise.all(
    skills.map(async (skill) => {
      const fullContent = await readFile(skill.filePath, "utf8");
      return skillSearchPassages(skill, fullContent, input.contentMode);
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

function skillSearchPassages(
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
