export type Bm25Document = {
  id: string;
  content: string;
};

export type Bm25SearchOptions = {
  maxResults?: number | undefined;
  maxSnippets?: number | undefined;
};

export type Bm25SearchResult = {
  id: string;
  score: number;
  snippets: string[];
};

type IndexedDocument = Bm25Document & {
  frequencies: Map<string, number>;
  length: number;
};

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_SNIPPETS = 3;
const K1 = 1.5;
const B = 0.75;

export function searchBm25(
  documents: Bm25Document[],
  query: string,
  options: Bm25SearchOptions = {},
): Bm25SearchResult[] {
  const queryTokens = uniqueTokens(tokenize(query));
  if (documents.length === 0 || queryTokens.length === 0) return [];

  const indexedDocuments = documents.map(indexDocument);
  const documentFrequencies = computeDocumentFrequencies(indexedDocuments);
  const averageDocumentLength =
    indexedDocuments.reduce((sum, document) => sum + document.length, 0) /
    indexedDocuments.length;
  const maxResults = clampPositiveInt(
    options.maxResults ?? DEFAULT_MAX_RESULTS,
    1,
    50,
  );
  const maxSnippets = clampPositiveInt(
    options.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    0,
    10,
  );

  return indexedDocuments
    .map((document) => ({
      id: document.id,
      score: scoreDocument({
        document,
        queryTokens,
        documentFrequencies,
        documentCount: indexedDocuments.length,
        averageDocumentLength,
      }),
      snippets: selectSnippets(document.content, queryTokens, maxSnippets),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxResults);
}

export function tokenize(text: string): string[] {
  const matches = text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[a-z0-9]+(?:[-_/.:][a-z0-9]+)*/g);
  if (!matches) return [];

  const tokens: string[] = [];
  for (const match of matches) {
    tokens.push(match);
    for (const part of match.split(/[-_/.:]+/)) {
      if (part.length > 0 && part !== match) tokens.push(part);
    }
  }
  return tokens;
}

function indexDocument(document: Bm25Document): IndexedDocument {
  const frequencies = new Map<string, number>();
  const tokens = tokenize([document.id, document.content].join("\n"));
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return {
    ...document,
    frequencies,
    length: tokens.length,
  };
}

function computeDocumentFrequencies(
  documents: IndexedDocument[],
): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.frequencies.keys()) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return frequencies;
}

function scoreDocument(input: {
  document: IndexedDocument;
  queryTokens: string[];
  documentFrequencies: Map<string, number>;
  documentCount: number;
  averageDocumentLength: number;
}): number {
  let score = 0;
  const lengthRatio =
    input.averageDocumentLength > 0
      ? input.document.length / input.averageDocumentLength
      : 1;

  for (const token of input.queryTokens) {
    const termFrequency = input.document.frequencies.get(token) ?? 0;
    if (termFrequency === 0) continue;

    const documentFrequency = input.documentFrequencies.get(token) ?? 0;
    const idf = Math.log(
      1 +
        (input.documentCount - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    const denominator = termFrequency + K1 * (1 - B + B * lengthRatio);
    score += idf * ((termFrequency * (K1 + 1)) / denominator);
  }

  return score;
}

function selectSnippets(
  content: string,
  queryTokens: string[],
  maxSnippets: number,
): string[] {
  if (maxSnippets === 0) return [];

  const scoredLines = content
    .split("\n")
    .map((line, index) => ({
      line,
      lineNumber: index + 1,
      score: countQueryTokens(line, queryTokens),
    }))
    .filter((line) => line.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.line.trim().length - b.line.trim().length ||
        a.lineNumber - b.lineNumber,
    );

  return scoredLines.slice(0, maxSnippets).map((line) => {
    const trimmed = trimSnippet(line.line.trim());
    return `${line.lineNumber}: ${trimmed}`;
  });
}

function countQueryTokens(line: string, queryTokens: string[]): number {
  const lineTokens = new Set(tokenize(line));
  let count = 0;
  for (const token of queryTokens) {
    if (lineTokens.has(token)) count += 1;
  }
  return count;
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function trimSnippet(text: string): string {
  const maxLength = 220;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function clampPositiveInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
