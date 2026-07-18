import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ApiTokenStore,
  apiTokenEntry,
} from "../../src/surfaces/api/auth/tokens";
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
const packagedAppExe = resolve(join(packagedRoot, "Sandi.exe"));
const launcherExe = resolve(
  process.env["SANDI_PACKAGED_APP_EXE"] ?? join(packagedRoot, "Sandi.exe"),
);
const fixture = join(
  join(packagedRoot, "resources", "app.asar"),
  "out/main/mcp-fixture.js",
);
const root = mkdtempSync(join(tmpdir(), "sandi-packaged-app-mcp-"));
const userData = join(root, "user-data");
const credentialsPath = join(root, "desktop.json");
const tokensPath = join(root, "tokens.json");
const statePath = join(root, "fixture-state.log");
const exitPath = join(root, "exit");
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
  `@set ELECTRON_RUN_AS_NODE=1\r\n@"${packagedAppExe}" "${fixture}" %*\r\n`,
);

const registry = new DeviceRegistry();
const broker = new ToolBroker(registry);
const tokenStore = new ApiTokenStore(tokensPath, 0);
const routes = new DeviceRoutes(registry, tokenStore);
const api = createServer(async (request, response) => {
  const presented = bearerToken(request.headers.authorization);
  const authenticated = presented
    ? await tokenStore.verify(presented)
    : undefined;
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
let shutdownError: Error | undefined;
let runError: unknown;
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
  app = spawn(launcherExe, [`--user-data-dir=${userData}`], {
    env: {
      ...process.env,
      PATH: join(process.env["SystemRoot"] ?? "C:\\Windows", "System32"),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      npm_config_offline: "true",
      PIP_NO_INDEX: "1",
      UV_OFFLINE: "1",
      NODE_OPTIONS: `--use-env-proxy --import=${pathToFileURL(join(import.meta.dirname, "offline-network-guard.mjs")).href}`,
      SANDI_MCP_OFFLINE_TEST: "1",
      SANDI_DESKTOP_CONFIG: credentialsPath,
      SANDI_MCP_FIXTURE_STATE: statePath,
      SANDI_PACKAGED_SMOKE_EXIT_FILE: exitPath,
    },
    stdio: "inherit",
  });
  await waitUntil(
    () => registry.identityForKey(entry.tokenSha256) === "ada",
    "desktop link",
    process.env["SANDI_PACKAGED_APP_EXE"] === undefined ? 30_000 : 180_000,
  );
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
  const jsRun = await callBroker(origin.ticket, "local_js_run", {
    code: 'console.log(JSON.stringify({ runtime: "electron-node", answer: 42 }))',
  });
  assert.equal(jsRun.ok, true, jsRun.error ?? "local_js_run failed");
  assert.match(textOf(jsRun), /electron-node/);
  assert.equal(jsRun.structuredContent?.["runtime"], "node");
  assert.equal(jsRun.structuredContent?.["exitCode"], 0);

  const autoitRun = await callBroker(origin.ticket, "local_autoit_run", {
    code: [
      "#include <SandiAutoIt.au3>",
      "Local $sInspection = SandiUIA_Inspect(HWnd(0), 0)",
      "Local $iInspectionError = @error",
      'Local $bInsertion = SandiEditor_InsertText(HWnd(0), 0, "", $SANDI_UIA_CUSTOM, "", "")',
      "Local $iInsertionError = @error",
      'ConsoleWrite(@AutoItVersion & "|" & @AutoItX64 & "|" & $SANDI_UIA_BUTTON & "|" & $iInspectionError & "|" & $iInsertionError & @CRLF)',
    ].join("\n"),
  });
  const expectedBundledError = process.env["SANDI_EXPECT_BUNDLED_ERROR"];
  if (expectedBundledError) {
    assert.equal(autoitRun.ok, false);
    assert.match(autoitRun.error ?? "", new RegExp(expectedBundledError));
    origin.revoke();
    console.log("packaged runtime corruption refusal: ok");
  } else {
    assert.equal(
      autoitRun.ok,
      true,
      autoitRun.error ?? "local_autoit_run failed",
    );
    assert.match(textOf(autoitRun), /3\.3\.18\.0\|1\|50000\|2\|40/);
    assert.equal(autoitRun.structuredContent?.["runtime"], "autoit");
    assert.equal(autoitRun.structuredContent?.["exitCode"], 0);
    assert.equal(autoitRun.structuredContent?.["syntaxCheck"], "passed");
    const syntaxMarker = join(root, "invalid-autoit-ran.marker");
    const invalidAutoIt = await callBroker(origin.ticket, "local_autoit_run", {
      code: [
        `FileWrite(${JSON.stringify(syntaxMarker)}, "must-not-run")`,
        'StringRepeat("x", 2)',
      ].join("\n"),
    });
    assert.equal(invalidAutoIt.ok, true);
    assert.equal(invalidAutoIt.isError, true);
    assert.equal(invalidAutoIt.structuredContent?.["phase"], "syntax_check");
    assert.equal(invalidAutoIt.structuredContent?.["syntaxCheck"], "failed");
    assert.equal(
      existsSync(syntaxMarker),
      false,
      "a syntax error is rejected before the script can mutate the desktop",
    );
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
      {
        name: "cached_tool",
        description: "Cached before spawn.",
        inputSchema: { type: "object" },
      },
    ]);
    const search = await callBroker(origin.ticket, "local_mcp", {
      operation: "search",
      query: "cached",
    });
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
    const identity = broker.lease({
      key: entry.tokenSha256,
      signal: new AbortController().signal,
    });
    const ambiguous = await callBroker(identity.ticket, "local_mcp", {
      operation: "servers",
    });
    assert.equal(ambiguous.ok, false);
    const selected = await callBroker(identity.ticket, "local_mcp", {
      operation: "servers",
      desktop: "Grace workstation",
    });
    assert.match(textOf(selected), /selected Grace workstation/);
    identity.revoke();
    const disabled = await callBroker(origin.ticket, "local_mcp_configure", {
      operation: "set_enabled",
      serverId: config.id,
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    await waitUntil(() => stateCount("exit") >= 1, "disable child exit");
    const enabled = await callBroker(origin.ticket, "local_mcp_configure", {
      operation: "set_enabled",
      serverId: config.id,
      enabled: true,
    });
    assert.equal(enabled.ok, true);
    await callBroker(origin.ticket, "local_mcp", {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "remove live" },
    });
    await waitUntil(() => stateCount("start") >= 2, "second child start");
    const removed = await callBroker(origin.ticket, "local_mcp_configure", {
      operation: "remove",
      serverId: config.id,
    });
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
      inheritEnv: [
        "PATH",
        "USERPROFILE",
        "TEMP",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NODE_OPTIONS",
      ],
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
    origin.revoke();
    console.log("packaged Electron MCP bridge smoke: ok");
  }
} catch (error) {
  runError = error;
} finally {
  if (app?.pid !== undefined) {
    writeFileSync(exitPath, "quit");
    const graceful = await waitForTermination(app, 10_000);
    if (!graceful) {
      spawnSync("taskkill.exe", ["/pid", String(app.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      await waitForTermination(app);
      shutdownError = new Error("packaged Sandi did not quit gracefully");
    }
  }
  registry.closeAll();
  broker.stop();
  await new Promise<void>((resolveClose) => api.close(() => resolveClose()));
  await removeEventually(root);
  runError ??= shutdownError;
}
if (runError !== undefined) throw runError;

function readState(): string[] {
  try {
    return readFileSync(statePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}
function stateCount(value: string): number {
  return readState().filter((entry) => entry === value).length;
}
function textOf(outcome: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return outcome.content.map((block) => block.text ?? "").join("\n");
}
async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function waitForTermination(
  child: ReturnType<typeof spawn> | undefined,
  timeoutMs?: number,
): Promise<boolean> {
  if (!child || child.exitCode !== null) return true;
  if (timeoutMs === undefined) {
    await new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    return true;
  }
  return new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", exited);
      resolveExit(false);
    }, timeoutMs);
    const exited = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", exited);
  });
}

async function removeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`timed out removing packaged smoke state ${path}`);
}
