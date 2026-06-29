import {
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "@/lib/surface-context";

// Surface context for the background consolidation turns (encode and dream).
//
// These turns get Sandi's full toolset, the same as a normal turn: dreaming is
// her own reflective pass and she keeps full agency over her memory, skills, and
// runtime while she does it. The material they read (a conversation transcript)
// has already been processed live by a full-tool turn, so re-reading it in the
// background opens no injection surface that did not already exist during the
// original conversation. This context exists only to wire the unified runtime so
// those tools compose; it is not tied to any human-facing surface, so it exposes
// no surface-specific skills.
export const DREAMING_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "dreaming",
  skillsSurface: "dreaming",
  runtimeImport: UNIFIED_RUNTIME_ENTRY,
  runtimeEntry: UNIFIED_RUNTIME_ENTRY,
};
