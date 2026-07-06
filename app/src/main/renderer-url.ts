// electron-vite exports ELECTRON_RENDERER_URL while its dev server runs. It
// is tooling-set, but it is still an environment value crossing into
// BrowserWindow.loadURL, so it parses like any other boundary: a loopback
// http origin, or startup fails loudly rather than loading a mangled URL.
export function parseRendererDevServerUrl(
  raw: string | undefined,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`ELECTRON_RENDERER_URL is not a valid URL: ${value}`);
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "http:" || !loopback) {
    throw new Error(
      `ELECTRON_RENDERER_URL must be a loopback http origin, got: ${value}`,
    );
  }
  return parsed.origin;
}
