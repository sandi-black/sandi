import type { SandiSurfaceContext } from "@/lib/surface-context";

export const GITHUB_RUNTIME_IMPORT = "./sandi/runtime.ts";
export const GITHUB_RUNTIME_ENTRY = "./src/surfaces/github/runtime/index.ts";

export const GITHUB_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "github",
  skillsSurface: "github",
  runtimeImport: GITHUB_RUNTIME_IMPORT,
  runtimeEntry: GITHUB_RUNTIME_ENTRY,
};

export function readGitHubPlatformContext(): string | undefined {
  const raw = process.env["SANDI_PLATFORM_CONTEXT"]?.trim();
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "platform" in parsed &&
      parsed.platform === "github"
    ) {
      return raw;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
