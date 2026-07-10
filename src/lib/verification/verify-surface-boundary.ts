import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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
    // Scan code only, not comments. The boundary we enforce is that a core
    // module must not couple itself to a surface in code (a surface-specific
    // string literal or field identifier); naming a surface in an explanatory
    // comment is fine, so stripping comments first avoids policing prose.
    const lines = stripComments(content);
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

// Returns the file's lines with comments blanked out, preserving line numbers so
// findings still point at the right place. String literals are kept (a surface
// name inside a real string is still coupling), so this walks characters
// tracking string and block-comment state rather than naively cutting at "//",
// which would also truncate a "https://" inside a string.
function stripComments(content: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  let inString: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    let code = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (inString) {
        code += ch;
        if (ch === "\\" && next !== undefined) {
          code += next;
          i += 1;
        } else if (ch === inString) {
          inString = undefined;
        }
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") inString = ch;
      code += ch;
    }
    out.push(code);
  }
  return out;
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
    path === "src/lib/pi-extension/memory-common.ts"
  ) {
    return (
      line.includes('z.enum(["discord", "github"])') ||
      line.includes('platform: "discord" | "github"')
    );
  }
  if (path === "src/lib/provider/pi-cli-client.ts") {
    return line.includes('delete env["SANDI_DISCORD_CONTEXT"]');
  }
  // The single canonical home for the reserved core memory root names: only
  // the reserved-root list entries themselves may name a surface, so any
  // other surface coupling added to this file is still caught.
  if (path === "src/lib/memory-refs.ts") {
    return line.trim() === '"discord",' || line.trim() === '"github",';
  }
  // The single surface registry: only the SURFACE_IDS declaration may name
  // the surfaces.
  if (path === "src/lib/surface-context.ts") {
    return line.includes(
      'export const SURFACE_IDS = ["discord", "github", "api"] as const;',
    );
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
  const entryFiles = [
    ...(await sourceFiles(join(repoRoot, "src", "lib", "pi-extension"))),
    ...(await surfacePiExtensionFiles()),
  ];
  const entrySet = new Set(entryFiles);
  // Walk the extension dependency graph transitively: the Pi CLI loader
  // resolves the whole chain, so an alias import three relative hops away
  // from an extension entry breaks loading just as surely as one in the
  // entry file itself (and has, in practice).
  const queue = [...entryFiles];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const content = await readFile(file, "utf8");
    for (const ref of importRefs(content)) {
      if (ref.source.startsWith("@/")) {
        // Statement-level `import type` is erased at runtime, so it cannot
        // break the loader; files outside the pi-extension folders may use it
        // for cross-boundary type references. Inside the folders the stricter
        // original rule stands: no alias imports of any kind.
        if (ref.typeOnly && !entrySet.has(file)) continue;
        findings.push({
          check: "pi-extension-imports",
          path: displayPath(file),
          message: `Pi extensions are loaded directly by the Pi CLI and must not rely on tsconfig path alias ${ref.source} (reachable from a Pi extension entry)`,
        });
        continue;
      }
      if (!ref.source.startsWith(".")) continue;
      const resolved = await resolveRelativeModule(file, ref.source);
      if (resolved) queue.push(resolved);
    }
  }
}

async function resolveRelativeModule(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next candidate shape.
    }
  }
  return undefined;
}

type ImportRef = { source: string; typeOnly: boolean };

// Like importSources, but keeps whether the statement is a type-only import
// (erased at emit, so invisible to the Pi CLI loader). Mixed forms such as
// `import { type X, y }` still emit a runtime import and count as value refs.
function importRefs(content: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const patterns = [
    /\bimport\s+(type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const source = match[2];
      if (source) refs.push({ source, typeOnly: match[1] !== undefined });
    }
  }
  return refs;
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
