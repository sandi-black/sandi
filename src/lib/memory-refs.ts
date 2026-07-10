// Shared by every module that turns a memory scope's declared ref prefix
// (e.g. "household/vacation-2026") into a validated, normalized path segment
// before it is resolved against the memory root. Kept free of other project
// imports on purpose: src/lib/pi-extension/memory-common.ts is loaded
// directly by the Pi CLI without the tsconfig path alias, so it reaches this
// module by a relative import, and this module must not pull in anything that
// import chain could not also resolve relatively.

// Top-level memory roots a scope-declared ref prefix must never collide with:
// the always-present system/self/household scopes, the topics area, and the
// surface-provided participant arenas (discord, github). Kept as plain
// literals rather than derived from the surface registry (src/lib/
// surface-context.ts) to keep this module dependency-free. The list may be
// stale against the current surfaces/... layout; that is a separate,
// deliberate question, not part of this consolidation.
const RESERVED_MEMORY_ROOTS = new Set([
  "system",
  "self",
  "household",
  "topics",
  "discord",
  "github",
]);

export type NormalizeRefPrefixOptions = {
  // The noun phrase used in the "Invalid ..." error when the prefix is
  // malformed. Callers historically phrased this message slightly
  // differently ("memory scope ref prefix" vs "conversation memory scope ref
  // prefix"); this keeps each caller's original wording intact.
  invalidLabel?: string;
};

/**
 * Validates and normalizes a memory scope ref prefix: backslashes become
 * forward slashes, a leading slash is stripped, and the result must be at
 * least two path segments deep with no empty, ".", or ".." segment, and must
 * not land on a reserved top-level memory root. Shared by every caller that
 * turns a scope-declared ref prefix into a path used to resolve memory on
 * disk, so the same prefix is judged valid or invalid the same way everywhere.
 */
export function normalizeRefPrefix(
  refPrefix: string,
  options: NormalizeRefPrefixOptions = {},
): string {
  const invalidLabel = options.invalidLabel ?? "memory scope ref prefix";
  const normalized = refPrefix.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Invalid ${invalidLabel}: ${refPrefix}`);
  }
  const root = parts[0];
  if (root !== undefined && RESERVED_MEMORY_ROOTS.has(root)) {
    throw new Error(
      `Conversation memory scope overlaps a core memory root: ${refPrefix}`,
    );
  }
  return parts.join("/");
}
