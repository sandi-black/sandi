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
  lines: IndexedLine[];
};

type IndexedLine = {
  line: string;
  lineNumber: number;
  tokens: ReadonlySet<string>;
};

export type Bm25Index = {
  documents: readonly IndexedDocument[];
  documentsById: ReadonlyMap<string, IndexedDocument>;
};

const DEFAULT_MAX_SNIPPETS = 3;
const K1 = 1.5;
const B = 0.75;
const STOPWORDS = new Set([
  "a",
  "about",
  "actually",
  "again",
  "all",
  "also",
  "alright",
  "an",
  "and",
  "anything",
  "are",
  "as",
  "at",
  "awesome",
  "be",
  "before",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "every",
  "for",
  "from",
  "fantastic",
  "get",
  "gets",
  "getting",
  "good",
  "great",
  "had",
  "has",
  "have",
  "hey",
  "hi",
  "hmm",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "job",
  "just",
  "kind",
  "like",
  "looks",
  "make",
  "maybe",
  "me",
  "my",
  "nah",
  "new",
  "nice",
  "no",
  "of",
  "ok",
  "okay",
  "on",
  "one",
  "or",
  "other",
  "out",
  "our",
  "please",
  "regard",
  "right",
  "say",
  "says",
  "said",
  "should",
  "sounds",
  "stuff",
  "that",
  "the",
  "thing",
  "things",
  "this",
  "to",
  "try",
  "up",
  "use",
  "we",
  "what",
  "when",
  "with",
  "work",
  "working",
  "works",
  "would",
  "yay",
  "yes",
  "yo",
  "you",
  "your",
]);

export function searchBm25(
  documents: Bm25Document[],
  query: string,
  options: Bm25SearchOptions = {},
): Bm25SearchResult[] {
  return searchBm25Index(buildBm25Index(documents), query, options);
}

/**
 * Stores query-independent lexical work so a loaded corpus can reuse its
 * tokenization without freezing the corpus statistics of any filtered view.
 */
export function buildBm25Index(documents: readonly Bm25Document[]): Bm25Index {
  const indexedDocuments = documents.map(indexDocument);
  const documentsById = new Map<string, IndexedDocument>();
  for (const document of indexedDocuments) {
    if (documentsById.has(document.id)) {
      throw new Error(`Duplicate BM25 document id: ${document.id}`);
    }
    documentsById.set(document.id, document);
  }
  return { documents: indexedDocuments, documentsById };
}

/**
 * Recomputes BM25 statistics over the requested IDs, preserving the exact
 * semantics of searching that document subset without re-tokenizing it.
 */
export function searchBm25Index(
  index: Bm25Index,
  query: string,
  options: Bm25SearchOptions = {},
  documentIds?: readonly string[] | undefined,
): Bm25SearchResult[] {
  const queryTokens = uniqueTokens(tokenize(query));
  const indexedDocuments = selectIndexedDocuments(index, documentIds);
  if (indexedDocuments.length === 0 || queryTokens.length === 0) return [];

  const documentFrequencies = computeDocumentFrequencies(indexedDocuments);
  const averageDocumentLength =
    indexedDocuments.reduce((sum, document) => sum + document.length, 0) /
    indexedDocuments.length;
  const maxSnippets = clampPositiveInt(
    options.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    0,
    10,
  );

  const results = indexedDocuments
    .map((document) => ({
      id: document.id,
      score: scoreDocument({
        document,
        queryTokens,
        documentFrequencies,
        documentCount: indexedDocuments.length,
        averageDocumentLength,
      }),
      snippets: selectSnippets(document.lines, queryTokens, maxSnippets),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const maxResults = positiveIntOrUndefined(options.maxResults);
  return maxResults === undefined ? results : results.slice(0, maxResults);
}

function selectIndexedDocuments(
  index: Bm25Index,
  documentIds: readonly string[] | undefined,
): readonly IndexedDocument[] {
  if (documentIds === undefined) return index.documents;
  return documentIds.map((id) => {
    const document = index.documentsById.get(id);
    if (!document) throw new Error(`BM25 index missing document id: ${id}`);
    return document;
  });
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
  return tokens.filter((token) => token.length > 1 && !STOPWORDS.has(token));
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
    lines: document.content.split("\n").map((line, index) => ({
      line,
      lineNumber: index + 1,
      tokens: new Set(tokenize(line)),
    })),
  };
}

function computeDocumentFrequencies(
  documents: readonly IndexedDocument[],
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
  lines: readonly IndexedLine[],
  queryTokens: string[],
  maxSnippets: number,
): string[] {
  if (maxSnippets === 0) return [];

  const scoredLines = lines
    .map((line) => ({
      ...line,
      score: countQueryTokens(line.tokens, queryTokens),
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

function countQueryTokens(
  lineTokens: ReadonlySet<string>,
  queryTokens: string[],
): number {
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
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function clampPositiveInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function positiveIntOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}
