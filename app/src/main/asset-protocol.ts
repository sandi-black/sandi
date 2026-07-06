import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

// Serves local files to the renderers as sandi-asset://<encoded absolute
// path>, for inline images and attachment previews. Any absolute path is
// served on purpose: sandi operates this machine with the human's own reach,
// and fencing her outputs off from her own chat window would be theater.

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
    if (!path) return new Response("bad asset url", { status: 400 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

export function assetUrl(path: string): string {
  return `${ASSET_SCHEME}://${encodeURIComponent(path)}`;
}

function decodeAssetUrl(url: string): string | undefined {
  const prefix = `${ASSET_SCHEME}://`;
  if (!url.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(url.slice(prefix.length));
  } catch {
    return undefined;
  }
}
