import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  deleteCustomSkill,
  formatSkillSource,
  listSkills,
  parseSkillWriteScope,
  readSkillsContext,
  resolveSkill,
  writeCustomSkill,
} from "./skill-common";

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
      }),
      async execute(_toolCallId, params) {
        const context = readSkillsContext();
        const result = await runSkillSearchAgent(
          context.root,
          context.surface,
          params.query,
        );
        return textResult(result, { delegated: true });
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

function runSkillSearchAgent(
  skillsRoot: string,
  skillsSurface: string | null,
  query: string,
): Promise<string> {
  const command = process.env["SANDI_PI_COMMAND"]?.trim() || "pi";
  const extensionPath = resolve(
    process.env["SANDI_PI_SKILL_SEARCH_EXTENSION"]?.trim() ||
      "src/lib/pi-extension/skill-search-read-tools.ts",
  );
  const timeoutMs = readPositiveIntEnv(
    "SANDI_PI_SKILL_SEARCH_TIMEOUT_MS",
    120_000,
  );
  const args = [
    "--print",
    "--no-builtin-tools",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--system-prompt",
    buildSkillSearchSystemPrompt(),
    "--no-session",
  ];

  const provider = process.env["SANDI_PI_PROVIDER"]?.trim();
  const model = process.env["SANDI_PI_MODEL"]?.trim();
  const thinking =
    process.env["SANDI_PI_SKILL_SEARCH_THINKING"]?.trim() || "medium";
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(buildSkillSearchUserPrompt(query));

  return new Promise((resolveSearch, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SANDI_SKILLS_ROOT: skillsRoot,
    };
    delete env["SANDI_SKILLS_SURFACE"];
    if (skillsSurface) env["SANDI_SKILLS_SURFACE"] = skillsSurface;

    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
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
            `skill search agent exited with code ${exitCode}`,
        ),
      );
    });
  });
}

function buildSkillSearchSystemPrompt(): string {
  return [
    "You are Sandi's read-only skill search subagent.",
    "",
    "Your job is to answer a query using only Sandi skills exposed through your tools.",
    "You cannot write, delete, edit, use surface runtime helpers, or access arbitrary files. Use the skill tools available to you.",
    "",
    "Skill organization:",
    "- core builtin/custom: globally reusable skills",
    "- surface builtin/custom: skills for the current surface",
    "- effective precedence is surface custom, surface builtin, core custom, core builtin",
    "",
    "Search strategy:",
    "1. Use BM25 search first for broad ranked recall.",
    "2. List available skills and inspect names/descriptions when useful for orientation.",
    "3. Use grep for exact identifiers, obvious terms, and related synonyms.",
    "4. Read promising skills fully before answering.",
    "5. Synthesize a concise answer and cite skill names.",
    "",
    "Rules:",
    "- Base your answer only on skill tool results.",
    "- If nothing relevant is found, say that clearly.",
    "- Do not mention filesystem paths.",
    "- Keep the answer compact enough to return as a tool result.",
  ].join("\n");
}

function buildSkillSearchUserPrompt(query: string): string {
  return ["Skill search query:", query].join("\n");
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

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}
