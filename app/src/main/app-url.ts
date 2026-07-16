import { isAbsolute, relative, resolve, sep } from "node:path";

export const APP_SCHEME = "sandi-app";

export type RendererSurface = "chat" | "pet";

export function appRendererUrl(surface: RendererSurface): string {
  return `${APP_SCHEME}://app/${surface}/index.html`;
}

export function resolveAppRequest(
  rawUrl: string,
  rendererRoot: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== `${APP_SCHEME}:` ||
    url.hostname !== "app" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }

  const candidate = resolve(rendererRoot, `.${pathname}`);
  const child = relative(rendererRoot, candidate);
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    return undefined;
  }
  return candidate;
}
