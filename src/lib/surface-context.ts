// The default `sandi_js_run` runtime entry. Every surface points here so a turn
// composes the same unified runtime regardless of where it originated: the
// module at this path re-exports every surface's server-side helpers. It is a
// plain path string (not an import) so naming it from core couples nothing.
export const UNIFIED_RUNTIME_ENTRY = "./src/host/runtime/index.ts";

// The single registry of human-facing surfaces Sandi dispatches turns to.
// Anything elsewhere in the codebase that needs to enumerate or type "which
// surfaces exist" (the identity platform union, a platform env context) should
// derive from this list rather than re-declaring its own.
export const SURFACE_IDS = ["discord", "github", "api"] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export type SandiSurfaceContext = {
  // Not typed as SurfaceId: the background dreaming turn (src/lib/memory/
  // dreaming-context.ts) constructs a SandiSurfaceContext with name and
  // skillsSurface both set to "dreaming", a pseudo-surface with no human-facing
  // channel. That constructor is legitimate, so narrowing either field to
  // SurfaceId would fail to typecheck against it; both stay open strings.
  name: string;
  skillsSurface: string;
  runtimeImport: string;
  runtimeEntry: string;
  attachmentsRoot?: string;
  // When set, the turn runs pi with --no-builtin-tools so its native file and
  // shell tools are off. The api surface sets this: those operations run on the
  // human's desktop through Sandi-owned proxy tools, never on the server.
  disableBuiltinTools?: boolean;
  // Extension tools to disable by name (pi --exclude-tools). The api surface
  // disables sandi_js_run here: it runs arbitrary code on the server, which a
  // hands-local turn must not do (the desktop is the workspace, and a shared
  // server would expose other members' data and secrets).
  excludeTools?: string[];
};

// Options for readPlatformContext's legacy env var fallback. Kept as a plain
// object (not inlined as a second positional string) so a future caller can
// add fields without every existing call site changing shape.
export type ReadPlatformContextOptions = {
  // A surface that predates the unified SANDI_PLATFORM_CONTEXT env var may
  // still be started with its own legacy context env var; naming it here lets
  // readPlatformContext fall back to it without hardcoding any surface's name.
  legacyEnvVar?: string;
};

/**
 * Reads the current turn's platform context (the raw SANDI_PLATFORM_CONTEXT
 * JSON) when it names the given surface, so a runtime helper can trust the
 * blob actually describes the surface it is about to act as. Shared by every
 * surface's `read<Surface>PlatformContext` wrapper; the surface id and any
 * legacy fallback env var are passed in rather than hardcoded here, so this
 * helper itself names no surface.
 */
export function readPlatformContext(
  platform: SurfaceId,
  options: ReadPlatformContextOptions = {},
): string | undefined {
  const raw = process.env["SANDI_PLATFORM_CONTEXT"]?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "platform" in parsed &&
        parsed.platform === platform
      ) {
        return raw;
      }
    } catch {
      return undefined;
    }
  }
  return options.legacyEnvVar
    ? process.env[options.legacyEnvVar]?.trim()
    : undefined;
}
