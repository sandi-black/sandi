import {
  readPlatformContext,
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "@/lib/surface-context";

export const GITHUB_RUNTIME_IMPORT = "./sandi/runtime.ts";
// Every surface composes the unified runtime, so a GitHub turn can also reach
// Discord and the desktop helpers, not only GitHub's own.
export const GITHUB_RUNTIME_ENTRY = UNIFIED_RUNTIME_ENTRY;

export const GITHUB_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "github",
  skillsSurface: "github",
  runtimeImport: GITHUB_RUNTIME_IMPORT,
  runtimeEntry: GITHUB_RUNTIME_ENTRY,
};

export function readGitHubPlatformContext(): string | undefined {
  return readPlatformContext("github");
}
