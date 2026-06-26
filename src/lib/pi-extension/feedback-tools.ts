import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { withManagedWrite } from "../state/managed-write";
import { PRIVATE_FILE_MODE } from "../state/private-files";

type FeedbackTargetType = "memory" | "skill";
type FeedbackSignal = "useful" | "distracting";
type FeedbackStage = "injected" | "searched" | "read" | "used" | "ignored";

type ResourceFeedbackInput = {
  targetType: FeedbackTargetType;
  targetRef: string;
  signal: FeedbackSignal;
  why: string;
  stage?: FeedbackStage;
};

type ResourceFeedbackRecord = {
  version: 1;
  id: string;
  created_at: string;
  target: {
    type: FeedbackTargetType;
    ref: string;
  };
  signal: FeedbackSignal;
  why: string;
  stage?: FeedbackStage;
  context: {
    conversation_id?: string;
    session_mode?: string;
    pi_account_id?: string;
    surface?: string;
  };
};

type RawContextMetadata = Record<
  keyof ResourceFeedbackRecord["context"],
  string | undefined
>;

const FEEDBACK_FILE = "resource-feedback.jsonl";

export default function feedbackToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "record_resource_feedback",
      label: "Record Memory/Skill Feedback",
      description:
        "Append durable feedback about whether a memory or skill was useful or distracting, and why.",
      promptSnippet:
        "Record memory/skill feedback when a retrieved, read, or hinted resource meaningfully helped or distracted Sandi. Do not record every retrieval automatically; record post-hoc judgment about actual usefulness.",
      parameters: Type.Object({
        targetType: Type.Union(
          [Type.Literal("memory"), Type.Literal("skill")],
          {
            description: "Whether the feedback target is a memory or a skill.",
          },
        ),
        targetRef: Type.String({
          description:
            "Logical memory ref or skill name/path/id being evaluated, such as system/MEMORY.md or pull-request.",
        }),
        signal: Type.Union(
          [Type.Literal("useful"), Type.Literal("distracting")],
          {
            description:
              "Whether the target helped the turn or distracted from it.",
          },
        ),
        why: Type.String({
          description:
            "Short explanation of how the target helped or distracted Sandi.",
        }),
        stage: Type.Optional(
          Type.Union(
            [
              Type.Literal("injected"),
              Type.Literal("searched"),
              Type.Literal("read"),
              Type.Literal("used"),
              Type.Literal("ignored"),
            ],
            {
              description:
                "Optional stage where the resource appeared or mattered: injected, searched, read, used, or ignored.",
            },
          ),
        ),
      }),
      async execute(_toolCallId, params) {
        const input: ResourceFeedbackInput = {
          targetType: params.targetType,
          targetRef: params.targetRef,
          signal: params.signal,
          why: params.why,
        };
        if (params.stage) input.stage = params.stage;
        const record = await appendResourceFeedback(input);
        return textResult(
          [
            `Feedback recorded: ${record.target.type} ${record.target.ref} was ${record.signal}.`,
            `Why: ${record.why}`,
          ].join("\n"),
          {
            id: record.id,
            path: feedbackFilePath(),
            targetType: record.target.type,
            targetRef: record.target.ref,
            signal: record.signal,
          },
        );
      },
    }),
  );
}

export async function appendResourceFeedback(
  input: ResourceFeedbackInput,
): Promise<ResourceFeedbackRecord> {
  const record = resourceFeedbackRecord(input);
  const path = feedbackFilePath();
  await withManagedWrite(path, async () => {
    await mkdir(join(feedbackRoot(), "resources"), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    await chmodPrivate(path);
  });
  return record;
}

export async function readResourceFeedbackJsonl(): Promise<string> {
  return await readFile(feedbackFilePath(), "utf8");
}

function resourceFeedbackRecord(
  input: ResourceFeedbackInput,
): ResourceFeedbackRecord {
  const stage = input.stage;
  return {
    version: 1,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    target: {
      type: input.targetType,
      ref: input.targetRef,
    },
    signal: input.signal,
    why: input.why,
    ...(stage ? { stage } : {}),
    context: contextMetadata(),
  };
}

function feedbackFilePath(): string {
  return join(feedbackRoot(), "resources", FEEDBACK_FILE);
}

function feedbackRoot(): string {
  return process.env["SANDI_FEEDBACK_ROOT"]?.trim() || "data/feedback";
}

function contextMetadata(): ResourceFeedbackRecord["context"] {
  const context: RawContextMetadata = {
    conversation_id: process.env["SANDI_CONVERSATION_ID"],
    session_mode: process.env["SANDI_SESSION_MODE"],
    pi_account_id: process.env["SANDI_PI_ACCOUNT_ID"],
    surface: process.env["SANDI_SKILLS_SURFACE"],
  };
  return cleanContext(context);
}

function cleanContext(
  context: RawContextMetadata,
): ResourceFeedbackRecord["context"] {
  return Object.fromEntries(
    Object.entries(context).filter((entry) => entry[1] !== undefined),
  );
}

async function chmodPrivate(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(path, PRIVATE_FILE_MODE);
}

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
