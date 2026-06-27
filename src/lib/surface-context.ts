// The default `sandi_js_run` runtime entry. Every surface points here so a turn
// composes the same unified runtime regardless of where it originated: the
// module at this path re-exports every surface's server-side helpers. It is a
// plain path string (not an import) so naming it from core couples nothing.
export const UNIFIED_RUNTIME_ENTRY = "./src/host/runtime/index.ts";

export type SandiSurfaceContext = {
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
