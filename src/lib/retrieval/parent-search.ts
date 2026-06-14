import {
  type HybridSearchOptions,
  type HybridSearchResult,
  hybridSearch,
  type RetrievalDocument,
} from "./hybrid-search";

export type SearchPassage = {
  parentId: string;
  passageId: string;
  content: string;
  label?: string | undefined;
  weight?: number | undefined;
};

export type ParentSearchPassageMatch = {
  passageId: string;
  label: string | null;
  score: number;
  bm25Score: number;
  bm25NormalizedScore: number;
  embeddingScore: number | null;
  matchedBy: HybridSearchResult["matchedBy"];
  snippets: string[];
};

export type ParentSearchResult = {
  id: string;
  score: number;
  bm25Score: number;
  bm25NormalizedScore: number;
  embeddingScore: number | null;
  matchedBy: HybridSearchResult["matchedBy"];
  snippets: string[];
  passages: ParentSearchPassageMatch[];
};

export type ParentSearchResponse = {
  results: ParentSearchResult[];
  embedding: Awaited<ReturnType<typeof hybridSearch>>["embedding"];
};

export type ParentSearchOptions = HybridSearchOptions & {
  supportingScoreWeight?: number | undefined;
};

type BuildMarkdownPassagesInput = {
  parentId: string;
  metadata: {
    content: string;
    label?: string | undefined;
    weight?: number | undefined;
  }[];
  markdown: string;
  maxChars?: number | undefined;
};

const DOCUMENT_ID_SEPARATOR = "\u001f";
const DEFAULT_PASSAGE_MAX_CHARS = 1_600;
const DEFAULT_SUPPORTING_SCORE_WEIGHT = 0.12;

export async function parentHybridSearch(
  passages: SearchPassage[],
  query: string,
  options: ParentSearchOptions = {},
): Promise<ParentSearchResponse> {
  const passageByDocumentId = new Map<string, SearchPassage>();
  const documents: RetrievalDocument[] = [];
  for (const passage of passages) {
    const content = passage.content.trim();
    if (content.length === 0) continue;
    const id = documentId(passage);
    passageByDocumentId.set(id, passage);
    documents.push({ id, content });
  }

  const response = await hybridSearch(documents, query, {
    maxSnippets: options.maxSnippets,
    minScore: options.minScore,
    minEmbeddingScore: options.minEmbeddingScore,
    minBm25NormalizedScore: options.minBm25NormalizedScore,
    lexicalMode: options.lexicalMode,
    embeddingEngine: options.embeddingEngine,
    queryExpansion: options.queryExpansion,
  });

  return {
    embedding: response.embedding,
    results: aggregateParentResults(
      response.results,
      passageByDocumentId,
      options.maxResults,
      options.maxSnippets,
      normalizedSupportingScoreWeight(options.supportingScoreWeight),
    ),
  };
}

export function buildMarkdownPassages(
  input: BuildMarkdownPassagesInput,
): SearchPassage[] {
  const passages: SearchPassage[] = input.metadata.map((metadata, index) => ({
    parentId: input.parentId,
    passageId: `metadata-${index + 1}`,
    content: metadata.content,
    label: metadata.label,
    weight: metadata.weight,
  }));
  const body = stripFrontmatter(input.markdown).trim();
  if (body.length === 0) return passages;

  const maxChars = input.maxChars ?? DEFAULT_PASSAGE_MAX_CHARS;
  let passageIndex = 1;
  for (const unit of markdownUnits(body)) {
    for (const chunk of splitToPassageChunks(unit.text, maxChars)) {
      passages.push({
        parentId: input.parentId,
        passageId: `body-${passageIndex}`,
        content: unit.heading ? `section: ${unit.heading}\n${chunk}` : chunk,
        label: unit.heading ?? "body",
      });
      passageIndex += 1;
    }
  }
  return passages;
}

function aggregateParentResults(
  results: HybridSearchResult[],
  passageByDocumentId: Map<string, SearchPassage>,
  maxResults: number | undefined,
  maxSnippets: number | undefined,
  supportingScoreWeight: number,
): ParentSearchResult[] {
  const matchesByParent = new Map<string, ParentSearchPassageMatch[]>();
  for (const result of results) {
    const passage = passageByDocumentId.get(result.id);
    if (!passage) {
      throw new Error(
        `Parent search result missing passage metadata: ${result.id}`,
      );
    }
    const weightedScore = result.score * (passage.weight ?? 1);
    const matches = matchesByParent.get(passage.parentId) ?? [];
    matches.push({
      passageId: passage.passageId,
      label: passage.label ?? null,
      score: weightedScore,
      bm25Score: result.bm25Score,
      bm25NormalizedScore: result.bm25NormalizedScore,
      embeddingScore: result.embeddingScore,
      matchedBy: result.matchedBy,
      snippets: passageSnippets(passage, result, maxSnippets),
    });
    matchesByParent.set(passage.parentId, matches);
  }

  const parents: ParentSearchResult[] = [];
  for (const [parentId, matches] of matchesByParent) {
    matches.sort(
      (a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId),
    );
    const top = matches[0];
    if (!top) continue;
    parents.push({
      id: parentId,
      score: parentScore(matches, supportingScoreWeight),
      bm25Score: top.bm25Score,
      bm25NormalizedScore: top.bm25NormalizedScore,
      embeddingScore: top.embeddingScore,
      matchedBy: aggregateMatchType(matches),
      snippets: collectParentSnippets(matches, maxSnippets),
      passages: matches.slice(0, 3),
    });
  }

  parents.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = positiveIntOrUndefined(maxResults);
  return limit === undefined ? parents : parents.slice(0, limit);
}

function parentScore(
  matches: ParentSearchPassageMatch[],
  supportingScoreWeight: number,
): number {
  const top = matches[0]?.score ?? 0;
  const supporting = matches
    .slice(1, 4)
    .reduce((sum, match) => sum + match.score, 0);
  return top + supporting * supportingScoreWeight;
}

function normalizedSupportingScoreWeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SUPPORTING_SCORE_WEIGHT;
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_SUPPORTING_SCORE_WEIGHT;
  }
  return value;
}

function aggregateMatchType(
  matches: ParentSearchPassageMatch[],
): HybridSearchResult["matchedBy"] {
  if (matches.some((match) => match.matchedBy === "hybrid")) return "hybrid";
  const hasEmbedding = matches.some((match) => match.matchedBy === "embedding");
  const hasBm25 = matches.some((match) => match.matchedBy === "bm25");
  if (hasEmbedding && hasBm25) return "hybrid";
  if (hasEmbedding) return "embedding";
  return "bm25";
}

function passageSnippets(
  passage: SearchPassage,
  result: HybridSearchResult,
  maxSnippets: number | undefined,
): string[] {
  const limit = maxSnippets ?? 3;
  if (limit <= 0) return [];
  const snippets =
    result.snippets.length > 0
      ? result.snippets
      : [trimSnippet(passage.content.replace(/\s+/gu, " "))];
  return snippets.slice(0, limit).map((snippet) => {
    const prefix = passage.label ? `${passage.label}: ` : "";
    return trimSnippet(`${prefix}${snippet}`);
  });
}

function collectParentSnippets(
  matches: ParentSearchPassageMatch[],
  maxSnippets: number | undefined,
): string[] {
  const limit = maxSnippets ?? 3;
  if (limit <= 0) return [];
  const snippets: string[] = [];
  for (const match of matches) {
    for (const snippet of match.snippets) {
      snippets.push(snippet);
      if (snippets.length >= limit) return snippets;
    }
  }
  return snippets;
}

type MarkdownUnit = {
  heading: string | null;
  text: string;
};

function markdownUnits(markdown: string): MarkdownUnit[] {
  const units: MarkdownUnit[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text.length > 0) units.push({ heading, text });
    paragraph = [];
  };

  for (const line of markdown.split("\n")) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
    if (headingMatch) {
      flush();
      heading = headingMatch[2] ?? null;
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return units;
}

function splitToPassageChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/u)) {
    if (sentence.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitRaw(sentence, maxChars));
      continue;
    }
    const next = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (next.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitRaw(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 3);
}

function documentId(passage: SearchPassage): string {
  return `${passage.parentId}${DOCUMENT_ID_SEPARATOR}${passage.passageId}`;
}

function trimSnippet(text: string): string {
  const maxLength = 220;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function positiveIntOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}
