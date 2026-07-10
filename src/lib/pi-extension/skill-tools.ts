import { readFile } from "node:fs/promises";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  deleteCustomSkill,
  formatSkillSource,
  listSkills,
  parseSkillWriteScope,
  readSkillsContext,
  resolveSkill,
  writeCustomSkill,
} from "./skill-common";
import {
  formatSkillHybridResult,
  type SkillHybridSearchResponse,
  searchSkillsHybrid,
} from "./skill-hybrid-search";
import { textResult } from "./tool-results";

const SkillNameParam = Type.String({
  description: "Skill name, such as skill-creator.",
});

export default function skillToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "skill_list",
      label: "List Skills",
      description:
        "List Sandi skills. Custom skills override builtins with the same name.",
      promptSnippet:
        "List skills when you need to inspect the available reusable operating instructions.",
      parameters: Type.Object({}),
      async execute() {
        const context = readSkillsContext();
        const skills = await listSkills(context);
        return textResult(formatSkillList(skills), { count: skills.length });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "skill_read",
      label: "Read Skill",
      description:
        "Read an effective Sandi skill by name. This does not expose arbitrary filesystem access.",
      promptSnippet:
        "Read a skill when its metadata suggests it applies and you need the full instructions.",
      parameters: Type.Object({
        name: SkillNameParam,
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
      name: "skill_search",
      label: "Search Skills",
      description:
        "Search Sandi skills for reusable instructions related to a natural-language query.",
      promptSnippet:
        "Search skills before assuming there is no reusable workflow for a topic.",
      parameters: Type.Object({
        query: Type.String({
          description: "Natural-language or keyword query.",
        }),
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
        const context = readSkillsContext();
        const result = await searchSkillsHybrid({
          root: context.root,
          surface: context.surface,
          query: params.query,
          maxResults: params.maxResults,
          maxSnippets: params.maxSnippets,
        });
        return textResult(formatSkillSearchResponse(result), {
          count: result.results.length,
          embedding: result.embedding,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "skill_write",
      label: "Write Skill",
      description:
        "Create or update a Sandi skill. Writes go to a custom core or surface skill and override a builtin with the same name in that scope.",
      promptSnippet:
        "Write a custom skill when Sandi should preserve or adjust reusable operating instructions. In a surface turn, default to the surface scope unless the instructions are truly global. Mention the change briefly.",
      parameters: Type.Object({
        name: SkillNameParam,
        content: Type.String({
          description:
            "Complete SKILL.md content with YAML frontmatter containing matching name and a description.",
        }),
        mode: Type.Optional(
          Type.String({
            description:
              "replace or append. Defaults to replace. Append starts from the effective skill, so appending to a builtin creates a custom override.",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description:
              "core or surface. Defaults to surface when the current turn has a surface context, otherwise core.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const context = readSkillsContext();
        const mode = params.mode === "append" ? "append" : "replace";
        const scope = parseSkillWriteScope(params.scope, context.surface);
        const result = await writeCustomSkill({
          root: context.root,
          surface: context.surface,
          scope,
          name: params.name,
          content: params.content,
          mode,
        });
        return textResult(
          [
            `Skill ${mode === "append" ? "appended" : "written"}: ${result.name}`,
            `Stored as a ${formatSkillSource(result.source)} skill. Mention this update briefly if it affects the current conversation.`,
          ].join("\n"),
          { name: result.name, source: formatSkillSource(result.source), mode },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "skill_delete",
      label: "Delete Custom Skill",
      description:
        "Delete a custom skill or custom override from the core or current surface scope. Reports the effective source revealed afterward, when one exists.",
      promptSnippet:
        "Delete a custom skill when someone asks Sandi to remove it or revert to the builtin version.",
      parameters: Type.Object({
        name: SkillNameParam,
        scope: Type.Optional(
          Type.String({
            description:
              "core or surface. Defaults to surface when the current turn has a surface context, otherwise core.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const context = readSkillsContext();
        const scope = parseSkillWriteScope(params.scope, context.surface);
        const result = await deleteCustomSkill({
          root: context.root,
          surface: context.surface,
          scope,
          name: params.name,
        });
        return textResult(formatSkillDeleteResult(result), {
          name: result.name,
          deletedSource: formatSkillSource(result.deletedSource),
          revealedSource: result.revealedSource
            ? formatSkillSource(result.revealedSource)
            : null,
          effectiveSource: result.effectiveSource
            ? formatSkillSource(result.effectiveSource)
            : null,
        });
      },
    }),
  );
}

function formatSkillSearchResponse(result: SkillHybridSearchResponse): string {
  const lines = [
    result.embedding.available
      ? `Embedding search: ${result.embedding.engine}`
      : `Embedding search unavailable; BM25-only results: ${result.embedding.reason}`,
    "",
    "Potentially relevant skills:",
  ];
  if (result.results.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(...result.results.map(formatSkillHybridResult));
  return lines.join("\n");
}

function formatSkillList(
  skills: {
    name: string;
    description: string | null;
    source: Parameters<typeof formatSkillSource>[0];
  }[],
): string {
  if (skills.length === 0) return "No skills found.";
  return skills
    .map((skill) =>
      [
        `${skill.name} (${formatSkillSource(skill.source)})`,
        skill.description ? `  ${skill.description}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    )
    .join("\n");
}

function formatSkillDeleteResult(result: {
  name: string;
  deletedSource: Parameters<typeof formatSkillSource>[0];
  revealedSource: Parameters<typeof formatSkillSource>[0] | null;
  effectiveSource: Parameters<typeof formatSkillSource>[0] | null;
}): string {
  const lines = [
    `Custom skill deleted: ${result.name} (${formatSkillSource(result.deletedSource)}).`,
  ];
  if (result.revealedSource) {
    lines.push(
      `Effective source now revealed: ${formatSkillSource(result.revealedSource)}.`,
    );
  } else if (result.effectiveSource) {
    lines.push(
      `Effective source is unchanged: ${formatSkillSource(result.effectiveSource)}.`,
    );
  } else {
    lines.push("No effective skill remains with that name.");
  }
  return lines.join("\n");
}
