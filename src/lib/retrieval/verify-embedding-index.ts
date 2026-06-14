import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  memoryEmbeddingIndexSnapshot,
  rebuildMemoryEmbeddingIndex,
  searchMemoryHybrid,
} from "@/lib/pi-extension/memory-hybrid-search";
import {
  rebuildSkillEmbeddingIndex,
  searchSkillsHybrid,
  skillEmbeddingIndexSnapshot,
} from "@/lib/pi-extension/skill-hybrid-search";
import {
  EMBEDDING_INDEX_VERSION,
  embeddingIndexCacheRoot,
  loadCurrentEmbeddingIndex,
} from "@/lib/retrieval/embedding-index";
import type { EmbeddingEngine } from "@/lib/retrieval/embeddings";

async function verifySkillIndex(dataDir: string): Promise<void> {
  const skillsRoot = join(dataDir, "skills");
  await writeSkill({
    root: join(skillsRoot, "core", "builtin"),
    name: "image-generation",
    description: "Use for image generation and visual scene creation.",
    body: "Generate images, visual references, and scenes.",
  });
  await writeSkill({
    root: join(skillsRoot, "surfaces", "chat", "builtin"),
    name: "chat-markdown",
    description: "Use for chat Markdown formatting.",
    body: "Format chat messages with markdown bullets and readable layout.",
  });

  const snapshot = await skillEmbeddingIndexSnapshot(skillsRoot);
  const rebuilt = await rebuildSkillEmbeddingIndex({
    root: skillsRoot,
    embeddingEngine: buildEmbeddingEngine,
  });
  assert.equal(rebuilt.rebuilt, true);

  const cached = await loadCurrentEmbeddingIndex({
    kind: "skills",
    cacheRoot: embeddingIndexCacheRoot(dataDir),
  });
  assert.equal(cached?.manifest.version, EMBEDDING_INDEX_VERSION);
  assert.equal(cached?.manifest.contentHash, snapshot.contentHash);
  assert.equal(cached?.manifest.sourceFileCount, 2);

  const search = await searchSkillsHybrid({
    root: skillsRoot,
    surface: "chat",
    query: "please generate an image in a scene",
    lexicalMode: "disabled",
    minScore: 0.1,
    minEmbeddingScore: 0.1,
    embeddingEngine: queryOnlyEmbeddingEngine,
  });
  assert.equal(search.results[0]?.name, "image-generation");

  await writeSkill({
    root: join(skillsRoot, "core", "builtin"),
    name: "image-generation",
    description: "Use for image generation and visual scene creation.",
    body: "Generate images, visual references, scenes, and mockups.",
  });
  const changedSnapshot = await skillEmbeddingIndexSnapshot(skillsRoot);
  assert.notEqual(changedSnapshot.contentHash, snapshot.contentHash);
  const stale = await loadCurrentEmbeddingIndex({
    kind: "skills",
    cacheRoot: embeddingIndexCacheRoot(dataDir),
  });
  assert.equal(stale?.manifest.contentHash, snapshot.contentHash);
}

async function verifyMemoryIndex(dataDir: string): Promise<void> {
  const memoryRoot = join(dataDir, "memory");
  await writeMemory({
    root: memoryRoot,
    ref: "github/user-1/preferences.md",
    summary: "Jess's development preferences.",
    body: "Jess usually prefers Node and TypeScript projects to run under Bun.",
  });
  await writeMemory({
    root: memoryRoot,
    ref: "topics/food/favorite-eats.md",
    summary: "Household favorite restaurants.",
    body: "Food, restaurants, dinner, and fallback options.",
  });

  const snapshot = await memoryEmbeddingIndexSnapshot(memoryRoot);
  const rebuilt = await rebuildMemoryEmbeddingIndex({
    root: memoryRoot,
    embeddingEngine: buildEmbeddingEngine,
  });
  assert.equal(rebuilt.rebuilt, true);

  const cached = await loadCurrentEmbeddingIndex({
    kind: "memory",
    cacheRoot: embeddingIndexCacheRoot(dataDir),
  });
  assert.equal(cached?.manifest.version, EMBEDDING_INDEX_VERSION);
  assert.equal(cached?.manifest.contentHash, snapshot.contentHash);
  assert.equal(cached?.manifest.sourceFileCount, 2);

  const search = await searchMemoryHybrid({
    root: memoryRoot,
    context: {
      memoryScopes: [],
      participants: [
        {
          platform: "github",
          platformUserId: "user-1",
          ref: "github/user-1/MEMORY.md",
          username: "jess",
        },
      ],
    },
    query: "what does jess prefer for node projects?",
    lexicalMode: "disabled",
    minScore: 0.1,
    minEmbeddingScore: 0.1,
    embeddingEngine: queryOnlyEmbeddingEngine,
  });
  assert.equal(search.results[0]?.ref, "github/user-1/preferences.md");
}

const buildEmbeddingEngine: EmbeddingEngine = {
  name: "test-index-embedding",
  async embed(input) {
    return input.map(testEmbedding);
  },
};

const queryOnlyEmbeddingEngine: EmbeddingEngine = {
  name: buildEmbeddingEngine.name,
  async embed(input) {
    assert.equal(input.length, 1, "cached search should embed only the query");
    return input.map(testEmbedding);
  },
};

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-embedding-index-"));
const previousDataDir = process.env["SANDI_DATA_DIR"];

try {
  const dataDir = join(tempRoot, "data");
  process.env["SANDI_DATA_DIR"] = dataDir;
  await verifySkillIndex(dataDir);
  await verifyMemoryIndex(dataDir);
  console.log("embedding index verification passed");
} finally {
  if (previousDataDir === undefined) {
    delete process.env["SANDI_DATA_DIR"];
  } else {
    process.env["SANDI_DATA_DIR"] = previousDataDir;
  }
  await rm(tempRoot, { recursive: true, force: true });
}

async function writeSkill(input: {
  root: string;
  name: string;
  description: string;
  body: string;
}): Promise<void> {
  const dir = join(input.root, input.name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.description}`,
      "---",
      "",
      input.body,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeMemory(input: {
  root: string;
  ref: string;
  summary: string;
  body: string;
}): Promise<void> {
  const filePath = join(input.root, input.ref);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(
    filePath,
    ["---", `summary: ${input.summary}`, "---", "", input.body, ""].join("\n"),
    "utf8",
  );
}

function testEmbedding(text: string): number[] {
  const normalized = text.toLowerCase();
  const vector = new Array<number>(6).fill(0.01);
  addSignals(vector, 0, normalized, [
    "image",
    "images",
    "visual",
    "generate",
    "scene",
    "mockup",
  ]);
  addSignals(vector, 1, normalized, ["markdown", "format", "chat", "layout"]);
  addSignals(vector, 2, normalized, [
    "prefer",
    "prefers",
    "node",
    "typescript",
    "bun",
    "development",
  ]);
  addSignals(vector, 3, normalized, ["food", "restaurant", "dinner"]);
  const magnitude = Math.hypot(...vector);
  return vector.map((value) => value / magnitude);
}

function addSignals(
  vector: number[],
  index: number,
  text: string,
  terms: string[],
): void {
  for (const term of terms) {
    if (text.includes(term)) vector[index] = (vector[index] ?? 0) + 1;
  }
}
