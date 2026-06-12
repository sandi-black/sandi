import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { writePrivateTextFile } from "../state/private-files";

export type SkillKind = "custom" | "builtin";
export type SkillScope = "core" | "surface";
export type SkillWriteScope = SkillScope;

export type SkillSource = {
  scope: SkillScope;
  kind: SkillKind;
  surface: string | null;
};

export type SkillMetadata = {
  name: string;
  description: string | null;
  source: SkillSource;
};

export type ResolvedSkill = SkillMetadata & {
  filePath: string;
};

type SkillLayer = {
  scope: SkillScope;
  kind: SkillKind;
  surface: string | null;
  root: string;
};

export type SkillRuntimeContext = {
  root: string;
  surface: string | null;
};

export function readSkillsRoot(): string {
  return readSkillsContext().root;
}

export function readSkillsContext(): SkillRuntimeContext {
  const rootValue = process.env["SANDI_SKILLS_ROOT"]?.trim();
  const dataDir = process.env["SANDI_DATA_DIR"]?.trim() || "./data";
  return {
    root: resolve(rootValue || resolve(dataDir, "skills")),
    surface: readOptionalSurface(process.env["SANDI_SKILLS_SURFACE"]),
  };
}

export async function listSkills(input: {
  root: string;
  surface?: string | null;
}): Promise<SkillMetadata[]> {
  const resolved = await listResolvedSkills(input);
  const skills = await Promise.all(
    resolved.map(async (skill) => {
      const metadata = parseSkillMetadata(
        await readFile(skill.filePath, "utf8"),
      );
      return {
        name: skill.name,
        description: metadata.description,
        source: skill.source,
      };
    }),
  );
  skills.sort(compareSkills);
  return skills;
}

export async function listResolvedSkills(input: {
  root: string;
  surface?: string | null;
}): Promise<ResolvedSkill[]> {
  const effective = new Map<string, ResolvedSkill>();
  for (const layer of skillLayers(input.root, input.surface ?? null)) {
    const names = await listSkillDirectoryNames(layer.root);
    for (const name of names) {
      const filePath = skillFilePath(layer.root, name);
      const metadata = parseSkillMetadata(await readFile(filePath, "utf8"));
      effective.set(name, {
        name,
        description: metadata.description,
        source: {
          scope: layer.scope,
          kind: layer.kind,
          surface: layer.surface,
        },
        filePath,
      });
    }
  }
  return [...effective.values()].sort(compareSkills);
}

export async function resolveSkill(
  root: string,
  name: string,
  surface?: string | null,
): Promise<ResolvedSkill> {
  const skillName = normalizeSkillName(name);
  const layers = skillLayers(root, surface ?? null).reverse();
  for (const layer of layers) {
    const filePath = skillFilePath(layer.root, skillName);
    if (!(await exists(filePath))) continue;
    const metadata = parseSkillMetadata(await readFile(filePath, "utf8"));
    return {
      name: skillName,
      description: metadata.description,
      source: {
        scope: layer.scope,
        kind: layer.kind,
        surface: layer.surface,
      },
      filePath,
    };
  }

  throw new Error(`Skill not found: ${name}`);
}

export async function readSkill(input: {
  root: string;
  name: string;
  surface?: string | null;
}): Promise<string> {
  const skill = await resolveSkill(input.root, input.name, input.surface);
  return readFile(skill.filePath, "utf8");
}

export async function writeCustomSkill(input: {
  root: string;
  surface?: string | null;
  scope: SkillWriteScope;
  name: string;
  content: string;
  mode: "replace" | "append";
}): Promise<{
  name: string;
  filePath: string;
  mode: "replace" | "append";
  source: SkillSource;
}> {
  const name = normalizeSkillName(input.name);
  const surface =
    input.scope === "surface" ? requireSurface(input.surface) : null;
  const root = customLayerRoot(input.root, input.scope, surface);
  const filePath = skillFilePath(root, name);
  const content =
    input.mode === "append"
      ? appendContent(
          await readEffectiveOrCustom({
            root: input.root,
            surface,
            scope: input.scope,
            name,
            customPath: filePath,
          }),
          input.content,
        )
      : `${input.content.trim()}\n`;
  validateSkillContent(name, content);
  await mkdir(dirname(filePath), { recursive: true });
  await writePrivateTextFile(filePath, content);
  return {
    name,
    filePath,
    mode: input.mode,
    source: {
      scope: input.scope,
      kind: "custom",
      surface,
    },
  };
}

export async function deleteCustomSkill(input: {
  root: string;
  surface?: string | null;
  scope: SkillWriteScope;
  name: string;
}): Promise<{
  name: string;
  deletedSource: SkillSource;
  revealedSource: SkillSource | null;
  effectiveSource: SkillSource | null;
}> {
  const skillName = normalizeSkillName(input.name);
  const surface =
    input.scope === "surface" ? requireSurface(input.surface) : null;
  const effectiveSurface = input.surface ?? null;
  const before = await resolveSkillOrNull({
    root: input.root,
    surface: effectiveSurface,
    name: skillName,
  });
  const root = customLayerRoot(input.root, input.scope, surface);
  const customPath = skillFilePath(root, skillName);
  await rm(dirname(customPath), { force: true, recursive: true });
  const after = await resolveSkillOrNull({
    root: input.root,
    surface: effectiveSurface,
    name: skillName,
  });
  const deletedSource: SkillSource = {
    scope: input.scope,
    kind: "custom",
    surface,
  };
  return {
    name: skillName,
    deletedSource,
    revealedSource:
      before && sourcesEqual(before.source, deletedSource)
        ? (after?.source ?? null)
        : null,
    effectiveSource: after?.source ?? null,
  };
}

export function defaultSkillWriteScope(
  surface: string | null,
): SkillWriteScope {
  return surface ? "surface" : "core";
}

export function parseSkillWriteScope(
  value: string | undefined,
  surface: string | null,
): SkillWriteScope {
  if (!value?.trim()) return defaultSkillWriteScope(surface);
  const normalized = value.trim().toLowerCase();
  if (normalized === "core" || normalized === "surface") return normalized;
  throw new Error('Skill scope must be "core" or "surface".');
}

export function formatSkillSource(source: SkillSource): string {
  if (source.scope === "core") return `core ${source.kind}`;
  return `surface:${source.surface ?? "unknown"} ${source.kind}`;
}

export function parseSkillMetadata(content: string): {
  name: string | null;
  description: string | null;
} {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return { name: null, description: null };

  let name: string | null = null;
  let description: string | null = null;
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key === "name") name = unquote(value);
    if (key === "description") description = unquote(value);
  }
  return { name, description };
}

export function normalizeSkillName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(normalized)) {
    throw new Error(
      "Skill names must use only letters, numbers, underscores, and hyphens.",
    );
  }
  return normalized;
}

function skillLayers(root: string, surface: string | null): SkillLayer[] {
  const normalizedSurface = surface ? normalizeSurfaceName(surface) : null;
  const layers: SkillLayer[] = [
    {
      scope: "core",
      kind: "builtin",
      surface: null,
      root: resolve(root, "core", "builtin"),
    },
    {
      scope: "core",
      kind: "custom",
      surface: null,
      root: resolve(root, "core", "custom"),
    },
  ];
  if (normalizedSurface) {
    layers.push(
      {
        scope: "surface",
        kind: "builtin",
        surface: normalizedSurface,
        root: resolve(root, "surfaces", normalizedSurface, "builtin"),
      },
      {
        scope: "surface",
        kind: "custom",
        surface: normalizedSurface,
        root: resolve(root, "surfaces", normalizedSurface, "custom"),
      },
    );
  }
  return layers;
}

function customLayerRoot(
  root: string,
  scope: SkillWriteScope,
  surface: string | null,
): string {
  if (scope === "core") return resolve(root, "core", "custom");
  return resolve(root, "surfaces", requireSurface(surface), "custom");
}

function skillFilePath(root: string, name: string): string {
  const absolute = resolve(root, name, "SKILL.md");
  const relativePath = relative(root, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return absolute;
}

async function listSkillDirectoryNames(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = normalizeSkillName(entry.name);
    if (await exists(skillFilePath(root, name))) {
      names.push(name);
    }
  }
  return names;
}

async function readEffectiveOrCustom(input: {
  root: string;
  surface: string | null;
  scope: SkillWriteScope;
  name: string;
  customPath: string;
}): Promise<string | null> {
  if (await exists(input.customPath)) {
    return readFile(input.customPath, "utf8");
  }
  try {
    if (input.scope === "core") {
      return await readSkill({ root: input.root, name: input.name });
    }
    return await readSkill({
      root: input.root,
      name: input.name,
      surface: input.surface,
    });
  } catch {
    return null;
  }
}

async function resolveSkillOrNull(input: {
  root: string;
  surface: string | null;
  name: string;
}): Promise<ResolvedSkill | null> {
  try {
    return await resolveSkill(input.root, input.name, input.surface);
  } catch {
    return null;
  }
}

function sourcesEqual(a: SkillSource, b: SkillSource): boolean {
  return a.scope === b.scope && a.kind === b.kind && a.surface === b.surface;
}

function validateSkillContent(name: string, content: string): void {
  const metadata = parseSkillMetadata(content);
  if (!metadata.name) {
    throw new Error("Skill content must include YAML frontmatter with name.");
  }
  if (metadata.name !== name) {
    throw new Error(
      `Skill frontmatter name (${metadata.name}) must match requested skill name (${name}).`,
    );
  }
  if (!metadata.description) {
    throw new Error(
      "Skill content must include YAML frontmatter with description.",
    );
  }
}

function parseFrontmatter(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  return content.slice(3, endIndex).trim();
}

function appendContent(existing: string | null, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!existing?.trim()) return `${trimmedAddition}\n`;
  return `${existing.trimEnd()}\n\n${trimmedAddition}\n`;
}

function readOptionalSurface(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return normalizeSurfaceName(trimmed);
}

function requireSurface(surface: string | null | undefined): string {
  if (!surface) {
    throw new Error("Surface skill scope requires a current skills surface.");
  }
  return normalizeSurfaceName(surface);
}

function normalizeSurfaceName(surface: string): string {
  const normalized = surface.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(normalized)) {
    throw new Error(
      "Surface names must use only letters, numbers, underscores, and hyphens.",
    );
  }
  return normalized;
}

function compareSkills(a: SkillMetadata, b: SkillMetadata): number {
  return a.name.localeCompare(b.name);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
