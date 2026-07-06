import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

// Serves local files to the renderers as sandi-asset://<encoded absolute
// path>, for inline images and attachment previews. Any absolute path is
// served on purpose (sandi operates this machine with the human's own reach,
// and fencing her outputs off from her own chat window would be theater),
// but the request must actually BE an absolute path: relative or malformed
// values never reach the filesystem resolution.

export const ASSET_SCHEME = "sandi-asset";

// Must run before app.whenReady.
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: false, stream: true, bypassCSP: false },
    },
  ]);
}

export function installAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const path = decodeAssetUrl(request.url);
    if (path === undefined) {
      return new Response("bad asset url", { status: 400 });
    }
    return net.fetch(pathToFileURL(path).toString());
  });
}

export function assetUrl(path: string): string {
  return `${ASSET_SCHEME}://${encodeURIComponent(path)}`;
}

// Renderer content is what mints these URLs, so the decoded value is parsed
// into the one shape the handler serves (an absolute local path, bounded in
// length) rather than passed to pathToFileURL as whatever string survived
// decoding.
function decodeAssetUrl(url: string): string | undefined {
  const prefix = `${ASSET_SCHEME}://`;
  if (!url.startsWith(prefix)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (decoded.length === 0 || decoded.length > 4096) return undefined;
  if (!isAbsolute(decoded)) return undefined;
  return decoded;
}
