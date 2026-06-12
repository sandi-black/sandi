import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type PolicySummary = {
  ref: string;
  title: string;
};

export async function listPolicies(root: string): Promise<PolicySummary[]> {
  return listPoliciesFromRoots([root]);
}

export async function listPoliciesFromRoots(
  roots: readonly string[],
): Promise<PolicySummary[]> {
  const absoluteRoots = uniqueResolvedRoots(roots);
  const refs: string[] = [];
  const seenRefs = new Set<string>();
  for (const root of absoluteRoots) {
    const rootRefs: string[] = [];
    await collectPolicyRefs(root, root, rootRefs);
    for (const ref of rootRefs) {
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      refs.push(ref);
    }
  }
  const policies = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      title:
        titleFromMarkdown(await readPolicyFromRoots(absoluteRoots, ref)) ?? ref,
    })),
  );
  return policies.sort((a, b) => a.ref.localeCompare(b.ref));
}

export async function readPolicyFromRoots(
  roots: readonly string[],
  ref: string,
): Promise<string> {
  let lastMissingError: unknown;
  for (const root of uniqueResolvedRoots(roots)) {
    try {
      return await readPolicy(root, ref);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      lastMissingError = error;
    }
  }
  if (lastMissingError instanceof Error) throw lastMissingError;
  throw new Error(`Policy not found: ${ref}`);
}

export async function readPolicy(root: string, ref: string): Promise<string> {
  return readFile(resolvePolicyRef(root, ref), "utf8");
}

export function resolvePolicyRef(root: string, ref: string): string {
  const absoluteRoot = resolve(root);
  const normalized = normalizePolicyRef(ref);
  const absolute = resolve(absoluteRoot, normalized);
  const relativePath = relative(absoluteRoot, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid policy ref: ${ref}`);
  }
  return absolute;
}

function normalizePolicyRef(ref: string): string {
  const normalized = ref.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    parts.length < 1 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Invalid policy ref: ${ref}`);
  }
  const filename = parts.at(-1);
  if (!filename?.endsWith(".md")) {
    throw new Error("Policy refs must point to Markdown files.");
  }
  return parts.join("/");
}

async function collectPolicyRefs(
  root: string,
  dir: string,
  refs: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPolicyRefs(root, absolute, refs);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      refs.push(relative(root, absolute).split(sep).join("/"));
    }
  }
}

function titleFromMarkdown(content: string): string | null {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    const title = match?.[1];
    if (title) return title.trim();
  }
  return null;
}

function uniqueResolvedRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const resolved = resolve(root);
    const key =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
