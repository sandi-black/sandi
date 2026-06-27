import {
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "@/lib/surface-context";

export const API_RUNTIME_IMPORT = "./sandi/runtime.ts";
// The desktop surface composes the same unified runtime as every other surface,
// so a desktop turn can reach Discord, GitHub, and the rest of Sandi's
// server-side helpers, not only the desktop proxy tools.
export const API_RUNTIME_ENTRY = UNIFIED_RUNTIME_ENTRY;

export const API_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "api",
  skillsSurface: "api",
  runtimeImport: API_RUNTIME_IMPORT,
  runtimeEntry: API_RUNTIME_ENTRY,
  // The desktop surface keeps pi's built-in file and shell tools off: file and
  // shell work flows to the human's desktop through the hands-local proxy tools,
  // not the server, so there is a single, unambiguous filesystem for those
  // operations. sandi_js_run stays enabled (it is how Sandi composes Discord,
  // GitHub, and other server-side helpers); the deployment is one trusted
  // environment, the same trust a Discord turn already runs under.
  disableBuiltinTools: true,
};
