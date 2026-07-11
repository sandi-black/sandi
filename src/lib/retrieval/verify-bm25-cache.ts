import assert from "node:assert/strict";

import {
  type Bm25Document,
  buildBm25Index,
  searchBm25,
  searchBm25Index,
} from "./bm25";

export function verifyBm25Cache(): void {
  const documents: Bm25Document[] = [
    {
      id: "github/grace/preferences.md\u001fmetadata-1",
      content: "summary: Grace prefers TypeScript services.\nplatform: GitHub",
    },
    {
      id: "github/grace/preferences.md\u001fbody-1",
      content:
        "Grace uses Bun for TypeScript projects.\nShe values fast verification.",
    },
    {
      id: "topics/food/restaurants.md\u001fmetadata-1",
      content: "summary: Ada's favorite dinner restaurants.",
    },
    {
      id: "topics/food/restaurants.md\u001fbody-1",
      content: "Ada likes noodles for dinner.\nThe fallback is pizza.",
    },
  ];
  const index = buildBm25Index(documents);

  verifySubsetEquality(
    index,
    documents,
    [documents[0], documents[1]],
    ["typescript bun", "verification preferences", "unknown phrase"],
  );
  verifySubsetEquality(
    index,
    documents,
    [documents[0], documents[2]],
    ["summary favorite", "github platform"],
  );
  verifySubsetEquality(index, documents, [], ["typescript"]);

  assert.deepEqual(
    searchBm25Index(index, "dinner noodles", { maxResults: 1, maxSnippets: 0 }),
    searchBm25(documents, "dinner noodles", {
      maxResults: 1,
      maxSnippets: 0,
    }),
  );
  assert.throws(
    () => searchBm25Index(index, "typescript", {}, ["missing-document"]),
    /BM25 index missing document id/,
  );
  const firstDocument = documents[0];
  assert.ok(firstDocument);
  assert.throws(
    () => buildBm25Index([firstDocument, firstDocument]),
    /Duplicate BM25 document id/,
  );
}

function verifySubsetEquality(
  index: ReturnType<typeof buildBm25Index>,
  allDocuments: readonly Bm25Document[],
  selectedDocuments: readonly (Bm25Document | undefined)[],
  queries: readonly string[],
): void {
  const selected = selectedDocuments.filter(
    (document): document is Bm25Document => document !== undefined,
  );
  const selectedIds = selected.map((document) => document.id);
  for (const query of queries) {
    for (const maxSnippets of [0, 1, 3, 10]) {
      const options = { maxResults: 2, maxSnippets };
      assert.deepEqual(
        searchBm25Index(index, query, options, selectedIds),
        searchBm25(
          allDocuments.filter((document) => selectedIds.includes(document.id)),
          query,
          options,
        ),
        `cached BM25 differs for query ${query} with ${maxSnippets} snippets`,
      );
    }
  }
}
