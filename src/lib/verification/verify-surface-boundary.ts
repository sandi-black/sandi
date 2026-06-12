import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { loadCoreConfig } from "@/lib/config/env";
import { listSkills } from "@/lib/pi-extension/skill-common";

type Finding = {
  check: string;
  path: string;
  message: string;
};

const repoRoot = process.cwd();
const findings: Finding[] = [];

await verifySharedCoreImports();
verifyCoreConfigDoesNotRequireDiscordEnv();
await verifyCoreHasNoSurfaceRuntimeLiterals();
await verifyCoreSkillsAreSurfaceNeutral();
await verifyCoreRuntimeBarrel();
await verifyPiExtensionImports();
await verifySkillSurfaceFiltering();

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.check}: ${finding.path}: ${finding.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("surface boundary verification passed");
}

async function verifySharedCoreImports(): Promise<void> {
  const files = [
    ...(await sourceFiles(join(repoRoot, "src", "lib"))),
    ...(await sourceFiles(join(repoRoot, "src", "runtime", "sandi"))),
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const source of importSources(content)) {
      if (source.includes("/surfaces/") || source.startsWith("@/surfaces/")) {
        findings.push({
          check: "shared-core-imports",
          path: displayPath(file),
          message: `shared core must not import surface module ${source}`,
        });
      }
    }
  }
}

function verifyCoreConfigDoesNotRequireDiscordEnv(): void {
  const discordEnvNames = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_TOKEN",
    "DISCORD_CLIENT_ID",
    "DISCORD_APPLICATION_ID",
    "DISCORD_GUILD_ID",
    "SANDI_FORUM_CHANNEL_ID",
    "SANDI_FORUM_CHANNEL_NAME",
    "SANDI_STATUS_CHANNEL_ID",
    "SANDI_STATUS_CHANNEL_NAME",
  ];
  const previous = new Map<string, string | undefined>();
  for (const name of discordEnvNames) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    loadCoreConfig();
  } catch (error) {
    findings.push({
      check: "core-config",
      path: "src/lib/config/env.ts",
      message: `loadCoreConfig should not require Discord env vars: ${errorMessage(error)}`,
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function verifyCoreSkillsAreSurfaceNeutral(): Promise<void> {
  const files = await markdownFiles(join(repoRoot, "data", "skills", "core"));
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/\bdiscord\b/i.test(content)) {
      findings.push({
        check: "core-skill-surface-neutrality",
        path: displayPath(file),
        message: "core skills must not mention Discord",
      });
    }
  }
}

async function verifyCoreHasNoSurfaceRuntimeLiterals(): Promise<void> {
  const files = [
    ...(await sourceFiles(join(repoRoot, "src", "lib"))),
    ...(await sourceFiles(join(repoRoot, "src", "runtime", "sandi"))),
  ];
  for (const file of files) {
    const path = displayPath(file);
    if (isSurfaceLiteralAllowedFile(path)) continue;
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = forbiddenSurfaceLiteral(line);
      if (!match || isAllowedSurfaceLiteralLine(path, line)) continue;
      findings.push({
        check: "core-surface-literals",
        path: `${path}:${index + 1}`,
        message: `core module contains surface-specific ${match}: ${line.trim()}`,
      });
    }
  }
}

function forbiddenSurfaceLiteral(line: string): string | undefined {
  const patterns: { label: string; pattern: RegExp }[] = [
    { label: "Discord literal", pattern: /\bdiscord\b/i },
    { label: "Discord env var", pattern: /\bSANDI_DISCORD_CONTEXT\b/ },
    {
      label: "Discord attachment env var",
      pattern: /\bSANDI_DISCORD_ATTACHMENTS_ROOT\b/,
    },
    { label: "Discord attachment path", pattern: /\bdiscord-attachments\b/i },
    { label: "legacy Discord user field", pattern: /\bdiscordUserId\b/ },
    { label: "legacy starter user field", pattern: /\bstarterUserId\b/ },
    { label: "surface guild field", pattern: /\bguildId\b/ },
    { label: "surface channel field", pattern: /\bchannelId\b/ },
    { label: "surface thread field", pattern: /\bthreadId\b/ },
  ];
  return patterns.find((item) => item.pattern.test(line))?.label;
}

function isSurfaceLiteralAllowedFile(path: string): boolean {
  return (
    path.startsWith("src/lib/migrations/") ||
    path.startsWith("src/lib/identity/") ||
    path === "src/lib/verification/verify-surface-boundary.ts"
  );
}

function isAllowedSurfaceLiteralLine(path: string, line: string): boolean {
  if (
    path === "src/lib/conversations/store.ts" ||
    path === "src/lib/context/memory.ts" ||
    path === "src/lib/pi-extension/memory-common.ts"
  ) {
    return (
      line.includes('z.enum(["discord", "github"])') ||
      line.includes('platform: "discord" | "github"') ||
      line.includes('root === "discord"') ||
      line.includes('root === "github"')
    );
  }
  if (path === "src/lib/provider/pi-cli-client.ts") {
    return line.includes('delete env["SANDI_DISCORD_CONTEXT"]');
  }
  return false;
}

async function verifyCoreRuntimeBarrel(): Promise<void> {
  const barrel = join(repoRoot, "src", "runtime", "sandi", "index.ts");
  const content = await readFile(barrel, "utf8");
  for (const source of importSources(content)) {
    if (!source.startsWith("@/lib/runtime/sandi/")) {
      findings.push({
        check: "core-runtime-barrel",
        path: displayPath(barrel),
        message: `core runtime barrel must only export shared helpers, found ${source}`,
      });
    }
  }
}

async function verifySkillSurfaceFiltering(): Promise<void> {
  const root = join(repoRoot, "data", "skills");
  const coreSkills = await listSkills({ root, surface: null });
  const discordSkills = await listSkills({ root, surface: "discord" });
  const leakedSurfaceSkill = coreSkills.find(
    (skill) => skill.source.scope === "surface",
  );
  if (leakedSurfaceSkill) {
    findings.push({
      check: "skill-effective-set",
      path: "data/skills",
      message: `surface skill ${leakedSurfaceSkill.name} is visible without surface context`,
    });
  }

  const discordOnlySkills = ["discord-participation", "reminders"];
  for (const name of discordOnlySkills) {
    if (coreSkills.some((skill) => skill.name === name)) {
      findings.push({
        check: "skill-effective-set",
        path: "data/skills",
        message: `${name} should be hidden without surface context`,
      });
    }
    if (!discordSkills.some((skill) => skill.name === name)) {
      findings.push({
        check: "skill-effective-set",
        path: "data/skills",
        message: `${name} should be visible with Discord surface context`,
      });
    }
  }

  const coreImageSkill = coreSkills.find(
    (skill) => skill.name === "image-generation",
  );
  if (coreImageSkill?.source.scope !== "core") {
    findings.push({
      check: "skill-effective-set",
      path: "data/skills",
      message:
        "image-generation should resolve to the core skill without surface context",
    });
  }
  const discordImageSkill = discordSkills.find(
    (skill) => skill.name === "image-generation",
  );
  if (discordImageSkill?.source.surface !== "discord") {
    findings.push({
      check: "skill-effective-set",
      path: "data/skills",
      message:
        "image-generation should resolve to the Discord override with Discord surface context",
    });
  }
}

async function verifyPiExtensionImports(): Promise<void> {
  const files = [
    ...(await sourceFiles(join(repoRoot, "src", "lib", "pi-extension"))),
    ...(await surfacePiExtensionFiles()),
  ];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const source of importSources(content)) {
      if (!source.startsWith("@/")) continue;
      findings.push({
        check: "pi-extension-imports",
        path: displayPath(file),
        message: `Pi extensions are loaded directly by the Pi CLI and must not rely on tsconfig path alias ${source}`,
      });
    }
  }
}

async function surfacePiExtensionFiles(): Promise<string[]> {
  const surfacesRoot = join(repoRoot, "src", "surfaces");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(surfacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(
      ...(await sourceFiles(join(surfacesRoot, entry.name, "pi-extension"))),
    );
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function importSources(content: string): string[] {
  const sources: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const source = match[1];
      if (source) sources.push(source);
    }
  }
  return sources;
}

async function sourceFiles(root: string): Promise<string[]> {
  return collectFiles(root, (name) => name.endsWith(".ts"));
}

async function markdownFiles(root: string): Promise<string[]> {
  return collectFiles(root, (name) => name.endsWith(".md"));
}

async function collectFiles(
  root: string,
  include: (name: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  await collect(root, include, files);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function collect(
  dir: string,
  include: (name: string) => boolean,
  files: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(path, include, files);
      continue;
    }
    if (entry.isFile() && include(entry.name)) files.push(path);
  }
}

function displayPath(path: string): string {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
