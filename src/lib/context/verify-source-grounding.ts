import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { rankedSkillHints } from "@/lib/context/skills";
import type { SkillMetadata } from "@/lib/pi-extension/skill-common";

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-source-grounding-"));

try {
  await verifyCompiledContextIncludesSourceGrounding(tempRoot);
  verifyWebResearchHinting();
  console.log("source grounding verification passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
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
}

function verifyWebResearchHinting(): void {
  const webResearch = skill("web-research", "Use web tools for citations.");
  const unrelated = skill("image-generation", "Create visual assets.");
  const hints = rankedSkillHints(
    [unrelated, webResearch],
    "please verify the latest facts and cite sources",
  );

  assert.equal(hints[0]?.skill.name, "web-research");
}

function skill(name: string, description: string): SkillMetadata {
  return {
    name,
    description,
    source: {
      scope: "core",
      kind: "builtin",
      surface: null,
    },
  };
}
