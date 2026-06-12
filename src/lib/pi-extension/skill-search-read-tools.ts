import { readFile } from "node:fs/promises";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { type Bm25SearchResult, searchBm25 } from "./bm25";
import {
  formatSkillSource,
  listSkills,
  readSkillsContext,
  resolveSkill,
} from "./skill-common";

export default function skillSearchReadToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "skill_find_files",
      label: "Find Skill Files",
      description:
        "List effective Sandi skills available to this read-only skill search session.",
      parameters: Type.Object({}),
      async execute() {
        const context = readSkillsContext();
        const skills = await listSkills(context);
        return textResult(
          skills.length > 0
            ? skills
                .map((skill) =>
                  [
                    `${skill.name} (${formatSkillSource(skill.source)})`,
                    skill.description ? `  ${skill.description}` : undefined,
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join("\n"),
                )
                .join("\n")
            : "No skills found.",
          { count: skills.length },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "skill_read_file",
      label: "Read Skill File",
      description:
        "Read an effective Sandi skill by name. Custom skills override builtins with the same name.",
      parameters: Type.Object({
        name: Type.String({
          description: "Skill name, such as skill-creator.",
        }),
      }),
      async execute(_toolCallId, params) {
        const context = readSkillsContext();
        const skill = await resolveSkill(
          context.root,
          params.name,
          context.surface,
        );
        const content = await readFile(skill.filePath, "utf8");
        return textResult(content, {
          name: skill.name,
          source: formatSkillSource(skill.source),
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "skill_bm25",
      label: "BM25 Skill Search",
      description:
        "Rank effective skill files with lexical BM25 search and return skill names with snippets.",
      parameters: Type.Object({
        query: Type.String({
          description: "Natural-language or keyword query.",
        }),
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum ranked skills to return. Defaults to 10.",
            minimum: 1,
            maximum: 50,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const context = readSkillsContext();
        const skills = await listSkills(context);
        const documents = await Promise.all(
          skills.map(async (listedSkill) => {
            const skill = await resolveSkill(
              context.root,
              listedSkill.name,
              context.surface,
            );
            return {
              id: skill.name,
              content: await readFile(skill.filePath, "utf8"),
            };
          }),
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
      name: "skill_grep",
      label: "Grep Skills",
      description:
        "Search effective skill files for literal text. Returns matching skill names and line numbers.",
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "Literal text to search for. Case-insensitive by default.",
        }),
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
        const context = readSkillsContext();
        const skills = await listSkills(context);
        const matches: string[] = [];
        const maxResults = clamp(params.maxResults ?? 50, 1, 200);
        const needle = params.caseSensitive
          ? params.pattern
          : params.pattern.toLowerCase();

        for (const listedSkill of skills) {
          const skill = await resolveSkill(
            context.root,
            listedSkill.name,
            context.surface,
          );
          const content = await readFile(skill.filePath, "utf8");
          const lines = content.split("\n");
          for (const [index, line] of lines.entries()) {
            const haystack = params.caseSensitive ? line : line.toLowerCase();
            if (!haystack.includes(needle)) continue;
            matches.push(`${skill.name}:${index + 1}: ${line}`);
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
  return Math.max(min, Math.min(max, value));
}
