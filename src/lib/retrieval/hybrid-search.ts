import { errorMessage } from "../errors";
import { type Bm25Index, searchBm25, searchBm25Index } from "./bm25";
import {
  cosineSimilarity,
  createEmbeddingEngineFromEnv,
  type EmbeddingEngine,
  type EmbeddingEngineStatus,
} from "./embeddings";

export type RetrievalDocument = {
  id: string;
  content: string;
};

export type HybridSearchOptions = {
  maxResults?: number | undefined;
  maxSnippets?: number | undefined;
  minScore?: number | undefined;
  minEmbeddingScore?: number | undefined;
  minBm25NormalizedScore?: number | undefined;
  lexicalMode?: "boost" | "fallback" | "disabled" | undefined;
  embeddingEngine?: EmbeddingEngine | null | undefined;
  queryExpansion?: string | undefined;
  documentEmbeddings?: ReadonlyMap<string, readonly number[]> | undefined;
  bm25Index?: Bm25Index | undefined;
};

export type HybridSearchResult = {
  id: string;
  score: number;
  bm25Score: number;
  bm25NormalizedScore: number;
  embeddingScore: number | null;
  snippets: string[];
  matchedBy: "hybrid" | "bm25" | "embedding";
};

export type HybridSearchResponse = {
  results: HybridSearchResult[];
  embedding: EmbeddingEngineStatus;
};

const LEXICAL_BOOST_WEIGHT = 0.2;
const DEFAULT_MIN_SCORE = 0.18;
const DEFAULT_MIN_EMBEDDING_SCORE = 0.22;
const DEFAULT_MIN_BM25_NORMALIZED_SCORE = 0.72;

export async function hybridSearch(
  documents: RetrievalDocument[],
  query: string,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResponse> {
  const trimmedQuery = query.trim();
  if (documents.length === 0 || trimmedQuery.length === 0) {
    return {
      results: [],
      embedding: { available: false, reason: "empty query or document set" },
    };
  }

  const retrievalQuery = options.queryExpansion?.trim()
    ? [trimmedQuery, options.queryExpansion.trim()].join("\n")
    : trimmedQuery;
  const bm25Options = { maxSnippets: options.maxSnippets };
  const bm25Results = options.bm25Index
    ? searchBm25Index(
        options.bm25Index,
        retrievalQuery,
        bm25Options,
        documents.map((document) => document.id),
      )
    : searchBm25(documents, retrievalQuery, bm25Options);
  const bm25ById = new Map(bm25Results.map((result) => [result.id, result]));
  const maxBm25Score = Math.max(
    0,
    ...bm25Results.map((result) => result.score),
  );
  const embeddingResponse = await scoreEmbeddings(
    documents,
    retrievalQuery,
    options.embeddingEngine,
    options.documentEmbeddings,
  );
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const minEmbeddingScore =
    options.minEmbeddingScore ?? DEFAULT_MIN_EMBEDDING_SCORE;
  const minBm25NormalizedScore =
    options.minBm25NormalizedScore ?? DEFAULT_MIN_BM25_NORMALIZED_SCORE;
  const lexicalMode = options.lexicalMode ?? "boost";
  const embeddingAvailable = embeddingResponse.status.available;

  const results = documents
    .map((document) => {
      const bm25 = bm25ById.get(document.id);
      const bm25Score = bm25?.score ?? 0;
      const bm25NormalizedScore =
        maxBm25Score > 0 ? bm25Score / maxBm25Score : 0;
      const embeddingScore = embeddingResponse.scores.get(document.id) ?? null;
      const effectiveEmbeddingScore =
        embeddingScore === null ? 0 : Math.max(0, embeddingScore);
      const score = scoreHybridResult({
        bm25NormalizedScore,
        embeddingAvailable,
        effectiveEmbeddingScore,
        lexicalMode,
      });
      const matchedBy = matchType({
        bm25Score,
        bm25NormalizedScore,
        embeddingScore,
        embeddingAvailable,
        lexicalMode,
        minEmbeddingScore,
        minBm25NormalizedScore,
      });
      return {
        id: document.id,
        score,
        bm25Score,
        bm25NormalizedScore,
        embeddingScore,
        snippets: bm25?.snippets ?? [],
        matchedBy,
      };
    })
    .filter(
      (result): result is HybridSearchResult =>
        result.matchedBy !== null && result.score >= minScore,
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const maxResults = positiveIntOrUndefined(options.maxResults);
  return {
    results: maxResults === undefined ? results : results.slice(0, maxResults),
    embedding: embeddingResponse.status,
  };
}

function scoreHybridResult(input: {
  bm25NormalizedScore: number;
  embeddingAvailable: boolean;
  effectiveEmbeddingScore: number;
  lexicalMode: NonNullable<HybridSearchOptions["lexicalMode"]>;
}): number {
  if (input.embeddingAvailable) {
    const lexicalBoost =
      input.lexicalMode === "boost"
        ? LEXICAL_BOOST_WEIGHT * input.bm25NormalizedScore
        : 0;
    return input.effectiveEmbeddingScore + lexicalBoost;
  }
  return input.lexicalMode === "disabled" ? 0 : input.bm25NormalizedScore;
}

function matchType(input: {
  bm25Score: number;
  bm25NormalizedScore: number;
  embeddingScore: number | null;
  embeddingAvailable: boolean;
  lexicalMode: NonNullable<HybridSearchOptions["lexicalMode"]>;
  minEmbeddingScore: number;
  minBm25NormalizedScore: number;
}): HybridSearchResult["matchedBy"] | null {
  const bm25CanMatch =
    input.lexicalMode === "boost" ||
    (input.lexicalMode === "fallback" && !input.embeddingAvailable);
  const bm25Matched =
    bm25CanMatch &&
    input.bm25Score > 0 &&
    (!input.embeddingAvailable ||
      input.bm25NormalizedScore >= input.minBm25NormalizedScore);
  const embeddingMatched =
    input.embeddingScore !== null &&
    input.embeddingScore >= input.minEmbeddingScore;
  if (bm25Matched && embeddingMatched) return "hybrid";
  if (bm25Matched) return "bm25";
  if (embeddingMatched) return "embedding";
  return null;
}

async function scoreEmbeddings(
  documents: RetrievalDocument[],
  retrievalQuery: string,
  configuredEngine: EmbeddingEngine | null | undefined,
  documentEmbeddings: ReadonlyMap<string, readonly number[]> | undefined,
): Promise<{
  status: EmbeddingEngineStatus;
  scores: Map<string, number>;
}> {
  const engine =
    configuredEngine === undefined
      ? createEmbeddingEngineFromEnv()
      : configuredEngine;
  if (!engine) {
    return {
      status: { available: false, reason: "embedding provider disabled" },
      scores: new Map(),
    };
  }

  try {
    if (documentEmbeddings) {
      const queryEmbedding = (await engine.embed([retrievalQuery]))[0];
      if (!queryEmbedding) {
        return {
          status: { available: false, reason: "query embedding missing" },
          scores: new Map(),
        };
      }
      const scores = new Map<string, number>();
      for (const document of documents) {
        const embedding = documentEmbeddings.get(document.id);
        if (!embedding) continue;
        scores.set(document.id, cosineSimilarity(queryEmbedding, embedding));
      }
      return {
        status: { available: true, engine: engine.name },
        scores,
      };
    }

    const embeddings = await engine.embed([
      retrievalQuery,
      ...documents.map((document) => document.content),
    ]);
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) {
      return {
        status: { available: false, reason: "query embedding missing" },
        scores: new Map(),
      };
    }
    const scores = new Map<string, number>();
    for (const [index, document] of documents.entries()) {
      const embedding = embeddings[index + 1];
      if (!embedding) continue;
      scores.set(document.id, cosineSimilarity(queryEmbedding, embedding));
    }
    return {
      status: { available: true, engine: engine.name },
      scores,
    };
  } catch (error) {
    return {
      status: {
        available: false,
        reason: errorMessage(error),
      },
      scores: new Map(),
    };
  }
}

function positiveIntOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}
