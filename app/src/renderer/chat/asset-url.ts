// Renderer-side twin of main's assetUrl: turns a local absolute path into a
// sandi-asset:// URL the custom protocol serves. Kept here (three lines)
// rather than imported, because the renderer cannot reach main-process
// modules.
export function assetUrl(path: string): string {
  return `sandi-asset://${encodeURIComponent(path)}`;
}

// True for the path shapes sandi writes in replies: drive-letter Windows
// paths and rooted POSIX paths.
export function isLocalAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}
