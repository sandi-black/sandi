import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { apiTokenEntry, ApiTokenStore } from "../../src/surfaces/api/auth/tokens";
import { DeviceRegistry } from "../../src/surfaces/api/devices/device-registry";
import { DeviceRoutes } from "../../src/surfaces/api/devices/device-routes";
import { ToolDispatchSchema } from "../../src/surfaces/api/devices/protocol";
import { ToolBroker } from "../../src/surfaces/api/devices/tool-broker";
import { bearerToken, sendJson } from "../../src/surfaces/api/http/respond";
import { callBroker } from "../../src/surfaces/api/pi-extension/tool-broker-client";
import { createMcpCatalogStore } from "../src/main/mcp/catalog-store";
import { createMcpConfigStore } from "../src/main/mcp/config-store";

const packagedRoot = resolve(
  process.env["SANDI_PACKAGED_APP_ROOT"] ?? "release/win-unpacked",
);
const appExe = join(packagedRoot, "Sandi.exe");
const fixture = join(
  join(packagedRoot, "resources", "app.asar"),
  "out/main/mcp-fixture.js",
);
const root = mkdtempSync(join(tmpdir(), "sandi-packaged-app-mcp-"));
const userData = join(root, "user-data");
const credentialsPath = join(root, "desktop.json");
const tokensPath = join(root, "tokens.json");
const statePath = join(root, "fixture-state.log");
const wrapperPath = join(root, "fixture.cmd");
const token = "a".repeat(64);
const entry = apiTokenEntry({
  token,
  identityId: "ada",
  deviceId: "Ada workstation",
  label: "Packaged app smoke",
});
const graceEntry = apiTokenEntry({
  token: "b".repeat(64),
  identityId: "ada",
  deviceId: "Grace workstation",
  label: "Packaged app smoke selector",
});
writeFileSync(
  tokensPath,
  `${JSON.stringify({ version: 1, tokens: [entry, graceEntry] })}\n`,
);
writeFileSync(
  wrapperPath,
  `@set ELECTRON_RUN_AS_NODE=1\r\n@\"${appExe}\" \"${fixture}\" %*\r\n`,
);

const registry = new DeviceRegistry();
const broker = new ToolBroker(registry);
const tokenStore = new ApiTokenStore(tokensPath, 0);
const routes = new DeviceRoutes(registry, tokenStore);
const api = createServer(async (request, response) => {
  const presented = bearerToken(request.headers.authorization);
  const authenticated = presented ? await tokenStore.verify(presented) : undefined;
  if (!authenticated) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.url === "/v1/devices/link" && request.method === "GET") {
    routes.handleLink(response, authenticated);
    return;
  }
  if (request.url === "/v1/devices/result" && request.method === "POST") {
    await routes.handleResult(request, response, authenticated);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
});

let app: ReturnType<typeof spawn> | undefined;
try {
  await broker.start();
  await new Promise<void>((resolveListen, rejectListen) => {
    api.once("error", rejectListen);
    api.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = api.address();
  assert(address && typeof address === "object");
  writeFileSync(
    credentialsPath,
    `${JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token, deviceId: "Ada workstation", identityId: "ada" })}\n`,
  );
  app = spawn(appExe, [`--user-data-dir=${userData}`], {
    env: {
      ...process.env,
      PATH: join(process.env["SystemRoot"] ?? "C:\\Windows", "System32"),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      npm_config_offline: "true",
      PIP_NO_INDEX: "1",
      UV_OFFLINE: "1",
      SANDI_DESKTOP_CONFIG: credentialsPath,
      SANDI_MCP_FIXTURE_STATE: statePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitUntil(() => registry.identityForKey(entry.tokenSha256) === "ada", "desktop link");
  registry.connect({
    key: graceEntry.tokenSha256,
    deviceId: "Grace workstation",
    identityId: "ada",
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      const data = match?.[1];
      if (data === undefined) return true;
      const dispatch = ToolDispatchSchema.parse(JSON.parse(data));
      queueMicrotask(() =>
        registry.settleResult(graceEntry.tokenSha256, {
          id: dispatch.id,
          ok: true,
          content: [{ type: "text", text: "selected Grace workstation" }],
        }),
      );
      return true;
    },
    end: () => undefined,
  });
  const origin = broker.lease({
    key: entry.tokenSha256,
    signal: new AbortController().signal,
    originDevice: true,
  });
  const config = {
    id: "packaged-fixture",
    label: "Packaged Grace Hopper fixture",
    enabled: true,
    command: { kind: "external" as const, executable: wrapperPath },
    args: [],
    inheritEnv: ["SANDI_MCP_FIXTURE_STATE"],
  };
  const approved = await callBroker(origin.ticket, "local_mcp_configure", {
    operation: "upsert",
    server: config,
  });
  assert.equal(approved.ok, true, "the packaged app saves the configuration");
  createMcpCatalogStore(join(userData, "mcp-catalogs")).save(config.id, [
    { name: "cached_tool", description: "Cached before spawn.", inputSchema: { type: "object" } },
  ]);
  const search = await callBroker(origin.ticket, "local_mcp", { operation: "search", query: "cached" });
  assert.match(textOf(search), /cached_tool/);
  assert.equal(readState().length, 0, "cached discovery starts no child");
  const called = await callBroker(origin.ticket, "local_mcp", {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: { message: "packaged Electron link" },
  });
  assert.equal(called.ok, true);
  assert.match(textOf(called), /packaged Electron link/);
  const identity = broker.lease({ key: entry.tokenSha256, signal: new AbortController().signal });
  const ambiguous = await callBroker(identity.ticket, "local_mcp", { operation: "servers" });
  assert.equal(ambiguous.ok, false);
  const selected = await callBroker(identity.ticket, "local_mcp", { operation: "servers", desktop: "Grace workstation" });
  assert.match(textOf(selected), /selected Grace workstation/);
  identity.revoke();
  const disabled = await callBroker(origin.ticket, "local_mcp_configure", { operation: "set_enabled", serverId: config.id, enabled: false });
  assert.equal(disabled.ok, true);
  await waitUntil(() => stateCount("exit") >= 1, "disable child exit");
  const enabled = await callBroker(origin.ticket, "local_mcp_configure", { operation: "set_enabled", serverId: config.id, enabled: true });
  assert.equal(enabled.ok, true);
  await callBroker(origin.ticket, "local_mcp", { operation: "call", serverId: config.id, toolName: "echo", arguments: { message: "remove live" } });
  await waitUntil(() => stateCount("start") >= 2, "second child start");
  const removed = await callBroker(origin.ticket, "local_mcp_configure", { operation: "remove", serverId: config.id });
  assert.equal(removed.ok, true);
  await waitUntil(() => stateCount("exit") >= 2, "removal child exit");
  assert.deepEqual(
    createMcpConfigStore(join(userData, "mcp-servers.json")).list(),
    [],
    "packaged removal deletes the persistent config entry",
  );
  assert.equal(
    existsSync(join(userData, "mcp-catalogs", `${config.id}.json`)),
    false,
    "packaged removal deletes the cached catalog",
  );

  const chromeConfig = {
    id: "packaged-chrome-mcp",
    label: "Packaged Chrome DevTools MCP",
    enabled: true,
    command: { kind: "bundled" as const, id: "chrome-devtools-mcp" },
    args: ["--headless"],
    inheritEnv: ["PATH", "USERPROFILE", "TEMP", "HTTP_PROXY", "HTTPS_PROXY"],
  };
  assert.equal(
    (
      await callBroker(origin.ticket, "local_mcp_configure", {
        operation: "upsert",
        server: chromeConfig,
      })
    ).ok,
    true,
  );
  const chromeStartup = await callBroker(origin.ticket, "local_mcp", {
    operation: "call",
    serverId: chromeConfig.id,
    toolName: "missing_after_catalog_refresh",
    arguments: {},
  });
  assert.equal(chromeStartup.ok, false);
  assert.match(chromeStartup.error ?? "", /not in the cached catalog/);
  const chromeSearch = await callBroker(origin.ticket, "local_mcp", {
    operation: "search",
    serverId: chromeConfig.id,
    query: "navigate",
  });
  assert.match(textOf(chromeSearch), /navigate_page/);
  assert.equal(
    (
      await callBroker(origin.ticket, "local_mcp_configure", {
        operation: "remove",
        serverId: chromeConfig.id,
      })
    ).ok,
    true,
  );

  const bundledConfig = {
    id: "packaged-windows-mcp",
    label: "Packaged Windows-MCP",
    enabled: true,
    command: { kind: "bundled" as const, id: "windows-mcp" },
    args: [],
    inheritEnv: [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "npm_config_offline",
      "PIP_NO_INDEX",
      "UV_OFFLINE",
    ],
  };
  assert.equal(
    (
      await callBroker(origin.ticket, "local_mcp_configure", {
        operation: "upsert",
        server: bundledConfig,
      })
    ).ok,
    true,
  );
  const bundledStartup = await callBroker(origin.ticket, "local_mcp", {
    operation: "call",
    serverId: bundledConfig.id,
    toolName: "missing_after_catalog_refresh",
    arguments: {},
  });
  assert.equal(bundledStartup.ok, false);
  assert.match(bundledStartup.error ?? "", /not in the cached catalog/);
  const bundledSearch = await callBroker(origin.ticket, "local_mcp", {
    operation: "search",
    serverId: bundledConfig.id,
    query: "Snapshot",
  });
  assert.match(textOf(bundledSearch), /Snapshot/);
  assert.equal(
    (
      await callBroker(origin.ticket, "local_mcp_configure", {
        operation: "remove",
        serverId: bundledConfig.id,
      })
    ).ok,
    true,
  );
  origin.revoke();
  console.log("packaged Electron MCP bridge smoke: ok");
} finally {
  if (app?.pid !== undefined) {
    spawnSync("taskkill.exe", ["/pid", String(app.pid), "/t", "/f"], {
      stdio: "ignore",
    });
  }
  await waitForTermination(app);
  registry.closeAll();
  broker.stop();
  await new Promise<void>((resolveClose) => api.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function readState(): string[] {
  try { return readFileSync(statePath, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
}
function stateCount(value: string): number { return readState().filter((entry) => entry === value).length; }
function textOf(outcome: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return outcome.content.map((block) => block.text ?? "").join("\n");
}
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function waitForTermination(
  child: ReturnType<typeof spawn> | undefined,
): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}
