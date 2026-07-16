import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { APP_SCHEME, resolveAppRequest } from "./app-url";
import { ASSET_SCHEME, installAssetProtocol } from "./asset-protocol";

const RENDERER_ROOT = join(import.meta.dirname, "../renderer");

export function registerRendererSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        bypassCSP: false,
        codeCache: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: false, stream: true, bypassCSP: false },
    },
  ]);
}

export function installRendererProtocols(): void {
  installAssetProtocol();
  protocol.handle(APP_SCHEME, (request) => {
    const path = resolveAppRequest(request.url, RENDERER_ROOT);
    if (!path) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}
