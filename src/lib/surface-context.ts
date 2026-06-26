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
};
