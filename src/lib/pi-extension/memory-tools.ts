import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { writePrivateTextFile } from "../state/private-files";
import {
  listAllowedRefs,
  parseFrontmatter,
  readMemoryContext,
  readMemoryRoot,
  resolveAllowedRef,
} from "./memory-common";

const RefParam = Type.String({
  description:
    "Logical memory ref, such as system/MEMORY.md, household/MEMORY.md, <platform>/<user-id>/preferences.md, topics/meal-planning/preferences.md, surfaces/<surface>/threads/<thread-id>/2026-05-04/recap.md, or surfaces/<surface>/channels/<channel-id>/MEMORY.md.",
});

const AreaParam = Type.Optional(
  Type.String({
    description:
      "Optional memory area or ref prefix to search/list: system, self, household, participants, a platform participant prefix, topics, current_thread, current_channel, parent_channel, current_conversation, or an explicitly exposed surfaces/<surface>/threads/<id> or surfaces/<surface>/channels/<id> scope.",
  }),
);

export default function memoryToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "memory_list",
      label: "List Memory",
      description:
        "List Sandi memory refs available in the current conversation context.",
      promptSnippet:
        "List memory when you need to inspect what Sandi can remember without reading every file.",
      parameters: Type.Object({
        area: AreaParam,
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const refs = await listAllowedRefs(root, context, params.area);
        return textResult(
          refs.length > 0
            ? refs.join("\n")
            : "No memory files found for the current context.",
          { count: refs.length },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_read",
      label: "Read Memory",
      description:
        "Read a Sandi memory file by logical ref. This does not expose arbitrary filesystem access.",
      promptSnippet:
        "Read a memory ref when the injected summary is relevant but you need details.",
      parameters: Type.Object({
        ref: RefParam,
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const filePath = resolveAllowedRef(root, context, params.ref);
        const content = await readFile(filePath, "utf8");
        return textResult(content, { ref: params.ref });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search Sandi memory files available in the current conversation context.",
      promptSnippet:
        "Search memory for machine details, past preferences, decisions, household context, topic context, and prior surface conversation summaries.",
      parameters: Type.Object({
        query: Type.String({
          description: "Natural-language or keyword query.",
        }),
        area: AreaParam,
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const result = await runMemorySearchAgent(
          root,
          JSON.stringify(context),
          params.query,
          params.area,
        );
        return textResult(result, { delegated: true });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_write",
      label: "Write Memory",
      description:
        "Create, replace, or append to a Sandi memory file by logical ref. Use this for clear, relevant continuity.",
      promptSnippet:
        "Write memory only when the fact, decision, preference, or summary is useful future context. Mention the update in the current conversation only when it is useful for the participant to know.",
      parameters: Type.Object({
        ref: RefParam,
        summary: Type.Optional(
          Type.String({
            description:
              "One-line summary for non-MEMORY.md files. Required when creating topic or temporal files.",
          }),
        ),
        content: Type.String({
          description:
            "Memory content. For non-MEMORY.md files this becomes the Markdown body below summary frontmatter.",
        }),
        mode: Type.Optional(
          Type.String({
            description:
              "replace or append. Defaults to replace. Append preserves existing content and summary unless a new summary is provided.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const filePath = resolveAllowedRef(root, context, params.ref);
        const mode = params.mode === "append" ? "append" : "replace";
        const writeInput: {
          filePath: string;
          ref: string;
          content: string;
          mode: "replace" | "append";
        } = {
          filePath,
          ref: params.ref,
          content: params.content,
          mode,
        };
        const content = await formatMemoryWrite(
          params.summary === undefined
            ? writeInput
            : { ...writeInput, summary: params.summary },
        );
        await mkdir(dirname(filePath), { recursive: true });
        await writePrivateTextFile(filePath, content);
        return textResult(
          [
            `Memory ${mode === "append" ? "appended" : "written"}: ${params.ref}`,
            params.summary ? `Summary: ${params.summary}` : undefined,
            "Mention this update only if it is useful in the current conversation.",
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
          { ref: params.ref, mode },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_forget",
      label: "Forget Memory",
      description:
        "Delete a Sandi memory file by logical ref. Use when someone asks Sandi to forget something or a memory is clearly wrong.",
      promptSnippet:
        "Forget memory when asked or when a stored memory is clearly incorrect. Make the deletion visible and easy to correct.",
      parameters: Type.Object({
        ref: RefParam,
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const filePath = resolveAllowedRef(root, context, params.ref);
        await rm(filePath, { force: true });
        return textResult(`Memory forgotten: ${params.ref}`, {
          ref: params.ref,
        });
      },
    }),
  );
}

function runMemorySearchAgent(
  memoryRoot: string,
  memoryContextJson: string,
  query: string,
  area: string | undefined,
): Promise<string> {
  const command = process.env["SANDI_PI_COMMAND"]?.trim() || "pi";
  const extensionPath = resolve(
    process.env["SANDI_PI_MEMORY_SEARCH_EXTENSION"]?.trim() ||
      "src/lib/pi-extension/memory-search-read-tools.ts",
  );
  const timeoutMs = readPositiveIntEnv(
    "SANDI_PI_MEMORY_SEARCH_TIMEOUT_MS",
    120_000,
  );
  const args = [
    "--print",
    "--no-builtin-tools",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--system-prompt",
    buildSearchSystemPrompt(area),
    "--no-session",
  ];

  const provider = process.env["SANDI_PI_PROVIDER"]?.trim();
  const model = process.env["SANDI_PI_MODEL"]?.trim();
  const thinking =
    process.env["SANDI_PI_MEMORY_SEARCH_THINKING"]?.trim() || "medium";
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(buildSearchUserPrompt(query, area));

  return new Promise((resolveSearch, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SANDI_MEMORY_ROOT: memoryRoot,
        SANDI_MEMORY_CONTEXT: memoryContextJson,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const output = stdout.join("").trim();
      if (exitCode === 0 && output) {
        resolveSearch(output);
        return;
      }
      reject(
        new Error(
          stderr.join("").trim() ||
            output ||
            `memory search agent exited with code ${exitCode}`,
        ),
      );
    });
  });
}

function buildSearchSystemPrompt(area: string | undefined): string {
  return [
    "You are Sandi's read-only memory search subagent.",
    "",
    "Your job is to answer a recall query using only Sandi memory files exposed through your tools.",
    "You cannot write, delete, edit, use surface runtime helpers, or access arbitrary files. Use the memory tools available to you.",
    "",
    "Memory organization:",
    "- system: machine, sandbox, tooling, paths, and runtime environment details",
    "- self: Sandi's own durable self-continuity",
    "- household: shared context for Sandi and the active group",
    "- participant platform arenas: active participant memory only",
    "- topics: recurring household topics and projects",
    "- surfaces/<surface>/threads: archived notes and recaps from surface threads",
    "- surfaces/<surface>/channels: room or channel continuity for surface conversation spaces",
    "",
    area
      ? `The caller requested area/prefix: ${area}`
      : "No area was specified; search broadly.",
    "",
    "Search strategy:",
    "1. Use BM25 search first for broad ranked recall, scoped to the requested area when provided.",
    "2. List candidate memory refs when useful for orientation.",
    "3. Use grep for exact identifiers, obvious terms, and related synonyms.",
    "4. Read promising files fully before answering.",
    "5. Synthesize a concise answer and cite memory refs by logical ref.",
    "",
    "Rules:",
    "- Base your answer only on memory tool results.",
    "- If nothing relevant is found, say that clearly.",
    "- Cite memory by logical ref, not by implementation file path.",
    "- Stored machine paths may be mentioned when they are the relevant remembered fact.",
    "- Keep the answer compact enough to return as a tool result.",
  ].join("\n");
}

function buildSearchUserPrompt(
  query: string,
  area: string | undefined,
): string {
  return [
    "Recall query:",
    query,
    "",
    area
      ? `Requested area/prefix: ${area}`
      : "Requested area/prefix: all allowed memory",
  ].join("\n");
}

async function formatMemoryWrite(input: {
  filePath: string;
  ref: string;
  summary?: string;
  content: string;
  mode: "replace" | "append";
}): Promise<string> {
  if (input.ref.endsWith("/MEMORY.md")) {
    if (input.mode === "append") {
      const existing = await readOptional(input.filePath);
      return appendContent(existing, input.content);
    }
    return `${input.content.trim()}\n`;
  }

  if (!input.summary && input.mode === "replace") {
    throw new Error("summary is required when writing non-MEMORY.md files.");
  }

  if (input.mode === "append") {
    const existing = await readOptional(input.filePath);
    const parsed = parseFrontmatter(existing ?? "");
    const summary = input.summary ?? parsed.summary;
    if (!summary) {
      throw new Error(
        "summary is required when appending to a non-MEMORY.md file without an existing summary.",
      );
    }
    return formatTopicFile(summary, appendContent(parsed.body, input.content));
  }

  return formatTopicFile(input.summary ?? "", input.content);
}

function formatTopicFile(summary: string, body: string): string {
  return `---\nsummary: ${cleanSummary(summary)}\n---\n\n${body.trim()}\n`;
}

function appendContent(existing: string | null, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!existing?.trim()) return `${trimmedAddition}\n`;
  return `${existing.trimEnd()}\n\n${trimmedAddition}\n`;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function cleanSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
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
