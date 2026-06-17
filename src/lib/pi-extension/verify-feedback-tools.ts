import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  appendResourceFeedback,
  readResourceFeedbackJsonl,
} from "./feedback-tools";

const FeedbackRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  created_at: z.string().min(1),
  target: z.object({
    type: z.enum(["memory", "skill"]),
    ref: z.string().min(1),
  }),
  signal: z.enum(["useful", "distracting"]),
  why: z.string().min(1),
  stage: z.enum(["injected", "searched", "read", "used", "ignored"]).optional(),
  context: z.object({
    conversation_id: z.string().optional(),
    surface: z.string().optional(),
  }),
});

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sandi-feedback-tools-"));
  try {
    process.env["SANDI_FEEDBACK_ROOT"] = root;
    process.env["SANDI_CONVERSATION_ID"] = "verify-conversation";
    process.env["SANDI_SKILLS_SURFACE"] = "verify-surface";

    await appendResourceFeedback({
      targetType: "memory",
      targetRef: "system/MEMORY.md",
      signal: "useful",
      why: "Verified useful memory feedback can be recorded.",
      stage: "used",
    });
    await appendResourceFeedback({
      targetType: "skill",
      targetRef: "pull-request",
      signal: "distracting",
      why: "Verified distracting skill feedback can be recorded.",
      stage: "ignored",
    });

    const lines = (await readResourceFeedbackJsonl()).trim().split("\n");
    assert(lines.length === 2, "expected two feedback JSONL records");

    const records = lines.map((line) =>
      FeedbackRecordSchema.parse(JSON.parse(line)),
    );
    const first = records[0];
    const second = records[1];
    assert(first !== undefined, "missing first feedback record");
    assert(second !== undefined, "missing second feedback record");
    assert(first.target.type === "memory", "first target should be memory");
    assert(first.signal === "useful", "first signal should be useful");
    assert(first.stage === "used", "first stage should be used");
    assert(
      first.context.conversation_id === "verify-conversation",
      "conversation id should be captured",
    );
    assert(
      first.context.surface === "verify-surface",
      "surface name should be captured",
    );
    assert(second.target.type === "skill", "second target should be skill");
    assert(
      second.signal === "distracting",
      "second signal should be distracting",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
console.log("feedback tools verification passed");
