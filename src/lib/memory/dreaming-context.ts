import {
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "@/lib/surface-context";

// Background consolidation turns run with pi's builtin file and shell tools off
// and server-side code execution (sandi_js_run) excluded, so reading potentially
// adversarial conversation content can never reach the server's filesystem,
// shell, or code runtime. This mirrors the trust boundary the api surface uses.
// They are not tied to any human-facing surface, so they expose no surface
// skills and the runtime entry is only a placeholder (sandi_js_run is excluded).
const BACKGROUND_BASE = {
  name: "dreaming",
  skillsSurface: "dreaming",
  runtimeImport: UNIFIED_RUNTIME_ENTRY,
  runtimeEntry: UNIFIED_RUNTIME_ENTRY,
  disableBuiltinTools: true,
};

// The idle encode pass only summarizes and returns text; the recap is written
// from that text by the harness, so it needs no tools at all. Exclude server
// code execution and every memory tool.
export const ENCODE_SURFACE_CONTEXT: SandiSurfaceContext = {
  ...BACKGROUND_BASE,
  excludeTools: [
    "sandi_js_run",
    "memory_list",
    "memory_read",
    "memory_search",
    "memory_write",
    "memory_forget",
  ],
};

// The dream consolidates using the memory tools, but never server-side code
// execution.
export const DREAM_SURFACE_CONTEXT: SandiSurfaceContext = {
  ...BACKGROUND_BASE,
  excludeTools: ["sandi_js_run"],
};
