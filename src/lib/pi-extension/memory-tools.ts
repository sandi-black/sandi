import { readFile, rm } from "node:fs/promises";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { atomicWriteInPlace, withManagedWrite } from "../state/managed-write";
import {
  listAllowedRefs,
  parseFrontmatter,
  readMemoryContext,
  readMemoryRoot,
  resolveAllowedRef,
} from "./memory-common";
import {
  formatMemoryHybridResult,
  type MemoryHybridSearchResponse,
  searchMemoryHybrid,
} from "./memory-hybrid-search";

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
        maxResults: Type.Optional(
          Type.Number({
            description:
              "Optional positive limit. Omit to return every result above the relevance threshold.",
            minimum: 1,
          }),
        ),
        maxSnippets: Type.Optional(
          Type.Number({
            description:
              "Maximum keyword snippets per result. Defaults to 3. Embedding-only matches may have no snippets.",
            minimum: 0,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const result = await searchMemoryHybrid({
          root,
          context,
          query: params.query,
          area: params.area,
          maxResults: params.maxResults,
          maxSnippets: params.maxSnippets,
        });
        return textResult(formatMemorySearchResponse(result), {
          count: result.results.length,
          embedding: result.embedding,
        });
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
        "You usually do not need to write memory during a conversation: your memory consolidates on its own while you rest. Write in the moment only when someone explicitly asks you to remember (or forget) something, or a detail is important and time-sensitive. When you do, mention it only if it is useful for the participant to know.",
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
        await withManagedWrite(filePath, async () => {
          const content = await formatMemoryWrite(
            params.summary === undefined
              ? writeInput
              : { ...writeInput, summary: params.summary },
          );
          await atomicWriteInPlace(filePath, content);
        });
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
        await withManagedWrite(filePath, async () => {
          await rm(filePath, { force: true });
        });
        return textResult(`Memory forgotten: ${params.ref}`, {
          ref: params.ref,
        });
      },
    }),
  );
}

function formatMemorySearchResponse(
  result: MemoryHybridSearchResponse,
): string {
  const lines = [
    result.embedding.available
      ? `Embedding search: ${result.embedding.engine}`
      : `Embedding search unavailable; BM25-only results: ${result.embedding.reason}`,
    "",
    "Potentially relevant memories:",
  ];
  if (result.results.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(...result.results.map(formatMemoryHybridResult));
  return lines.join("\n");
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

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
