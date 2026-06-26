import type { SandiSurfaceContext } from "@/lib/surface-context";

export const API_RUNTIME_IMPORT = "./sandi/runtime.ts";
export const API_RUNTIME_ENTRY = "./src/surfaces/api/runtime/index.ts";

export const API_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "api",
  skillsSurface: "api",
  runtimeImport: API_RUNTIME_IMPORT,
  runtimeEntry: API_RUNTIME_ENTRY,
  // The api surface is hands-local: pi's built-in file and shell tools are
  // disabled and replaced by proxy tools that run on the caller's desktop.
  disableBuiltinTools: true,
};
