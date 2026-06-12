import { readFile } from "node:fs/promises";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { type Bm25SearchResult, searchBm25 } from "./bm25";
import {
  listAllowedRefs,
  readMemoryContext,
  readMemoryRoot,
  resolveAllowedRef,
} from "./memory-common";

const AreaParam = Type.Optional(
  Type.String({
    description:
      "Optional memory area or ref prefix: system, self, household, participants, a platform participant prefix, topics, current_thread, current_channel, parent_channel, current_conversation, or an explicitly exposed surfaces/<surface>/threads/<id> or surfaces/<surface>/channels/<id> scope.",
  }),
);

export default function memorySearchReadToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "memory_find_files",
      label: "Find Memory Files",
      description:
        "List logical memory refs available to this read-only memory search session.",
      parameters: Type.Object({
        area: AreaParam,
      }),
      async execute(_toolCallId, params) {
        const refs = await listAllowedRefs(
          readMemoryRoot(),
          readMemoryContext(),
          params.area,
        );
        return textResult(
          refs.length > 0 ? refs.join("\n") : "No memory files found.",
          { count: refs.length },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_read_file",
      label: "Read Memory File",
      description:
        "Read a logical memory ref available to this read-only memory search session.",
      parameters: Type.Object({
        ref: Type.String({
          description:
            "Logical memory ref, such as system/MEMORY.md, household/MEMORY.md, or topics/meal-planning/preferences.md.",
        }),
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const content = await readFile(
          resolveAllowedRef(root, context, params.ref),
          "utf8",
        );
        return textResult(content, { ref: params.ref });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_bm25",
      label: "BM25 Memory Search",
      description:
        "Rank allowed memory files with lexical BM25 search and return refs with snippets.",
      parameters: Type.Object({
        query: Type.String({
          description: "Natural-language or keyword query.",
        }),
        area: AreaParam,
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum ranked files to return. Defaults to 10.",
            minimum: 1,
            maximum: 50,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const refs = await listAllowedRefs(root, context, params.area);
        const documents = await Promise.all(
          refs.map(async (ref) => ({
            id: ref,
            content: await readFile(
              resolveAllowedRef(root, context, ref),
              "utf8",
            ),
          })),
        );
        const results = searchBm25(documents, params.query, {
          maxResults: params.maxResults,
        });
        return textResult(formatBm25Results(results), {
          count: results.length,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_grep",
      label: "Grep Memory",
      description:
        "Search allowed memory files for literal text. Returns matching refs and line numbers.",
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "Literal text to search for. Case-insensitive by default.",
        }),
        area: AreaParam,
        caseSensitive: Type.Optional(
          Type.Boolean({
            description: "Whether matching should be case-sensitive.",
          }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum matching lines to return. Defaults to 50.",
            minimum: 1,
            maximum: 200,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const root = readMemoryRoot();
        const context = readMemoryContext();
        const refs = await listAllowedRefs(root, context, params.area);
        const matches: string[] = [];
        const maxResults = clamp(params.maxResults ?? 50, 1, 200);
        const needle = params.caseSensitive
          ? params.pattern
          : params.pattern.toLowerCase();

        for (const ref of refs) {
          const content = await readFile(
            resolveAllowedRef(root, context, ref),
            "utf8",
          );
          const lines = content.split("\n");
          for (const [index, line] of lines.entries()) {
            const haystack = params.caseSensitive ? line : line.toLowerCase();
            if (!haystack.includes(needle)) continue;
            matches.push(`${ref}:${index + 1}: ${line}`);
            if (matches.length >= maxResults) {
              return textResult(matches.join("\n"), {
                count: matches.length,
                truncated: true,
              });
            }
          }
        }

        return textResult(
          matches.length > 0 ? matches.join("\n") : "No matches.",
          { count: matches.length, truncated: false },
        );
      },
    }),
  );
}

function formatBm25Results(results: Bm25SearchResult[]): string {
  if (results.length === 0) return "No matches.";
  return results
    .map((result) =>
      [
        `${result.id} (score ${result.score.toFixed(3)})`,
        ...result.snippets.map((snippet) => `  ${snippet}`),
      ].join("\n"),
    )
    .join("\n");
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
