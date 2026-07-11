import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { isMissingPathError } from "../fs-errors";

export type PolicySummary = {
  ref: string;
  title: string;
};

// listPoliciesFromRoots recursively walks every policies root on every call
// (soul/policy sections get recompiled each turn), but a policy file's title
// only changes when its content does. Caching the extracted title by path +
// mtimeMs + size avoids re-reading and re-parsing every policy file's full
// content just to pull the first `# heading` out of files that have not
// changed since the last compile.
const TITLE_CACHE = new Map<
  string,
  { statKey: string; title: string | null }
>();

export async function listPoliciesFromRoots(
  roots: readonly string[],
): Promise<PolicySummary[]> {
  const absoluteRoots = uniqueResolvedRoots(roots);
  const refs: string[] = [];
  const seenRefs = new Set<string>();
  const pathByRef = new Map<string, string>();
  for (const root of absoluteRoots) {
    const rootRefs: string[] = [];
    await collectPolicyRefs(root, root, rootRefs);
    for (const ref of rootRefs) {
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      refs.push(ref);
      pathByRef.set(ref, resolvePolicyRef(root, ref));
    }
  }
  const policies = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      title:
        (await cachedPolicyTitle(absoluteRoots, ref, pathByRef.get(ref))) ??
        ref,
    })),
  );
  pruneTitleCache(absoluteRoots, new Set(pathByRef.values()));
  return policies.sort((a, b) => a.ref.localeCompare(b.ref));
}

// Deleted or renamed policy files would otherwise pin their cache entries for
// the process lifetime. Pruning is scoped to the roots this call walked so a
// process hosting compilers with different policy roots does not have one
// compiler's compile evict another's still-valid entries.
function pruneTitleCache(
  walkedRoots: readonly string[],
  livePaths: ReadonlySet<string>,
): void {
  for (const key of TITLE_CACHE.keys()) {
    if (livePaths.has(key)) continue;
    if (walkedRoots.some((root) => key.startsWith(root + sep))) {
      TITLE_CACHE.delete(key);
    }
  }
}

async function cachedPolicyTitle(
  roots: readonly string[],
  ref: string,
  path: string | undefined,
): Promise<string | null> {
  const statKey = path ? await fileStatKey(path) : null;
  const cacheKey = path ?? ref;
  if (statKey) {
    const cached = TITLE_CACHE.get(cacheKey);
    if (cached && cached.statKey === statKey) return cached.title;
  }

  const title = titleFromMarkdown(await readPolicyFromRoots(roots, ref));
  if (statKey) TITLE_CACHE.set(cacheKey, { statKey, title });
  return title;
}

async function fileStatKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
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
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
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
