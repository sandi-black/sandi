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
  // sandi_js_run executes arbitrary code on the server. A hands-local turn must
  // not: the desktop is the workspace, and on a shared server it would reach
  // other members' data. Disabled here so file and shell work has only one path,
  // the desktop proxy tools.
  excludeTools: ["sandi_js_run"],
};
