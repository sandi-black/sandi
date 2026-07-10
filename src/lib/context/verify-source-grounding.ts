import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { loadMemory, type MemoryContext } from "@/lib/context/memory";
import { loadSkillsGuidance } from "@/lib/context/skills";
import { searchSkillsHybrid } from "@/lib/pi-extension/skill-hybrid-search";
import type { EmbeddingEngine } from "@/lib/retrieval/embeddings";
import { withTempDir } from "@/lib/verification/harness";

const testEmbeddingEngine: EmbeddingEngine = {
  name: "test-keyword-embedding",
  async embed(input) {
    return input.map(testEmbedding);
  },
};

const previousProvider = process.env["SANDI_EMBEDDING_PROVIDER"];
process.env["SANDI_EMBEDDING_PROVIDER"] = "disabled";

try {
  await withTempDir("sandi-source-grounding-", async (tempRoot) => {
    await verifyCompiledContextIncludesSourceGrounding(tempRoot);
    await verifyWebResearchHinting(tempRoot);
    await verifyPromptSkillHintTuning(tempRoot);
    await verifyPromptMemoryHintTuning(tempRoot);
    console.log("source grounding verification passed");
  });
} finally {
  if (previousProvider === undefined) {
    delete process.env["SANDI_EMBEDDING_PROVIDER"];
  } else {
    process.env["SANDI_EMBEDDING_PROVIDER"] = previousProvider;
  }
}

async function verifyCompiledContextIncludesSourceGrounding(
  root: string,
): Promise<void> {
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(configDir, "soul.md"), "# Test Soul\n", "utf8");

  const prompt = await new ContextCompiler(configDir, dataDir).compileOneOff({
    author: {
      platform: "github",
      platformUserId: "user-1",
      username: "example-user",
      joinedAt: "2026-06-11T00:00:00.000Z",
    },
    title: "Source Grounding Test",
    metadata: "metadata: true",
    deliveryInstructions: "Deliver one test response.",
    skillHintQuery: "what is the latest fact with sources?",
  });

  assert.match(prompt, /# Source Grounding/);
  assert.match(prompt, /Prefer verifying factual answers/);
  assert.match(prompt, /cite the sources in the visible response/);
  assert.match(prompt, /\[label\]\(url\)/);
  assert.doesNotMatch(prompt, /Available effective skill index/);
}

async function verifyWebResearchHinting(root: string): Promise<void> {
  const skillsRoot = join(root, "data", "skills", "core", "builtin");
  await writeSkill({
    root: skillsRoot,
    name: "web-research",
    description: "Use web tools for citations.",
    body: "Search, verify, cite sources, and check latest facts.",
  });
  await writeSkill({
    root: skillsRoot,
    name: "image-generation",
    description: "Create visual assets.",
    body: "Generate images and visual references.",
  });
  const hints = await searchSkillsHybrid({
    root: join(root, "data", "skills"),
    query: "please verify the latest facts and cite sources",
    maxSnippets: 0,
  });

  assert.equal(hints.results[0]?.name, "web-research");
}

async function verifyPromptSkillHintTuning(root: string): Promise<void> {
  const coreSkillsRoot = join(root, "data", "skills", "core", "builtin");
  const chatSkillsRoot = join(
    root,
    "data",
    "skills",
    "surfaces",
    "chat",
    "builtin",
  );
  await writeSkill({
    root: coreSkillsRoot,
    name: "todo-list",
    description: "Use for household todo list capture and checkbox formatting.",
    body: "Chat todo list formatting: omit the checkbox prefix and use dashes for task items.",
  });
  await writeSkill({
    root: chatSkillsRoot,
    name: "chat-markdown",
    description: "Use for chat Markdown formatting.",
    body: "Chat formatting markdown bullet dashes readable messages",
  });

  const imagePrompt = await skillGuidance(
    root,
    "try generating an image with her in a scene",
    testEmbeddingEngine,
  );
  assert.match(imagePrompt, /Potentially relevant skills to the prompt/);
  assert.match(imagePrompt, /image-generation/);
  assert.match(imagePrompt, /match: score /);
  assert.match(imagePrompt, /why: /);

  const todoPrompt = await skillGuidance(
    root,
    "some changes to the code: omit the checkbox prefix and use dashes in chat",
    testEmbeddingEngine,
  );
  assert.match(todoPrompt, /todo-list/);
  assert.match(todoPrompt, /chat-markdown/);
  assert.match(todoPrompt, /checkbox/);

  const casualPrompt = await skillGuidance(
    root,
    "Yay, good job",
    testEmbeddingEngine,
  );
  assert.doesNotMatch(
    casualPrompt,
    /Potentially relevant skills to the prompt/,
  );

  const vagueRecallPrompt = await skillGuidance(
    root,
    "do you remember what we decided before?",
    testEmbeddingEngine,
  );
  assert.doesNotMatch(
    vagueRecallPrompt,
    /Potentially relevant skills to the prompt/,
  );
}

async function verifyPromptMemoryHintTuning(root: string): Promise<void> {
  const memoryRoot = join(root, "data", "memory");
  await writeMemory({
    root: memoryRoot,
    ref: "github/user-1/preferences.md",
    summary: "Jess's development preferences.",
    body: "Jess usually prefers node projects to run in Bun. PRIVATE_BODY_MARKER",
  });
  await writeMemory({
    root: memoryRoot,
    ref: "topics/food/favorite-eats.md",
    summary: "Household favorite restaurants by category.",
    body: "Food, restaurants, dinner, and nothing sounds good fallback options.",
  });
  await writeMemory({
    root: memoryRoot,
    ref: "topics/games/dice.md",
    summary: "Dice game notes.",
    body: "Dice combat idle game notes.",
  });
  const context: MemoryContext = {
    memoryRoot,
    memoryScopes: [],
    participants: [
      {
        platform: "github",
        platformUserId: "user-1",
        username: "jess",
        joinedAt: "2026-06-11T00:00:00.000Z",
      },
    ],
  };

  const preferencePrompt = await loadMemory(
    context,
    "nice. i usually prefer node projects to run in bun",
    { embeddingEngine: testEmbeddingEngine },
  );
  assert.match(preferencePrompt, /github\/user-1\/preferences\.md/);
  assert.match(preferencePrompt, /Jess's development preferences/);
  assert.match(preferencePrompt, /match: score /);
  assert.match(preferencePrompt, /why: matched /);
  assert.doesNotMatch(preferencePrompt, /PRIVATE_BODY_MARKER/);

  const foodPrompt = await loadMemory(
    context,
    "what should we eat tonight? nothing sounds good",
    { embeddingEngine: testEmbeddingEngine },
  );
  assert.match(foodPrompt, /topics\/food\/favorite-eats\.md/);

  const vagueRecallPrompt = await loadMemory(
    context,
    "do you remember what we decided before?",
    { embeddingEngine: testEmbeddingEngine },
  );
  assert.doesNotMatch(
    vagueRecallPrompt,
    /Potentially relevant memories to the prompt/,
  );
}

async function skillGuidance(
  root: string,
  hintQuery: string,
  embeddingEngine?: EmbeddingEngine | null,
): Promise<string> {
  return await loadSkillsGuidance({
    skillsRoot: join(root, "data", "skills"),
    surface: "chat",
    hintQuery,
    embeddingEngine,
  });
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
  const vector = new Array<number>(10).fill(0.01);
  addSignals(vector, 0, normalized, [
    "image",
    "images",
    "visual",
    "generate",
    "generating",
    "scene",
  ]);
  addSignals(vector, 1, normalized, [
    "todo",
    "to-do",
    "task",
    "tasks",
    "checkbox",
    "check box",
    "list",
  ]);
  addSignals(vector, 2, normalized, [
    "chat",
    "markdown",
    "bullet",
    "bullets",
    "dash",
    "dashes",
    "formatting",
  ]);
  addSignals(vector, 3, normalized, [
    "tweet",
    "tweets",
    "source",
    "sources",
    "latest",
    "cite",
    "web",
  ]);
  addSignals(vector, 4, normalized, [
    "food",
    "eat",
    "dinner",
    "restaurant",
    "restaurants",
    "nothing sounds good",
  ]);
  addSignals(vector, 5, normalized, [
    "prefer",
    "prefers",
    "preference",
    "node",
    "typescript",
    "bun",
    "development",
  ]);
  addSignals(vector, 6, normalized, ["game", "games", "dice", "bdo"]);
  addSignals(vector, 7, normalized, ["remind", "reminder", "followup"]);
  addSignals(vector, 8, normalized, ["recipe", "recipes", "soup"]);
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
