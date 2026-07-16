import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpCatalogStore } from "./catalog-store";
import { createMcpConfigStore } from "./config-store";
import { createMcpHost } from "./mcp-host";
import { createDesktopToolExecutor } from "./tool-executor";
import type { DesktopToolExecutor } from "@sandi-server/surfaces/api/client/desktop-client";
import { DeviceRegistry } from "@sandi-server/surfaces/api/devices/device-registry";
import {
  type ToolCallOutcome,
  ToolDispatchSchema,
} from "@sandi-server/surfaces/api/devices/protocol";
import { ToolBroker } from "@sandi-server/surfaces/api/devices/tool-broker";
import { callBroker } from "@sandi-server/surfaces/api/pi-extension/tool-broker-client";

const fixture = process.argv[2];
if (!fixture) throw new Error("packaged MCP smoke requires a fixture path");

const root = mkdtempSync(join(tmpdir(), "sandi-packaged-mcp-"));
const statePath = join(root, "fixture-state.log");
const serverId = "packaged-fixture";
const registry = new DeviceRegistry();
const broker = new ToolBroker(registry);
const host = createMcpHost({
  userDataDir: root,
  resolveBundled: (id) =>
    id === "packaged-smoke"
      ? {
          executable: process.execPath,
          argsPrefix: [fixture],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            SANDI_MCP_FIXTURE_STATE: statePath,
          },
        }
      : undefined,
});
const config = {
  id: serverId,
  label: "Packaged Grace Hopper fixture",
  enabled: true,
  command: { kind: "bundled" as const, id: "packaged-smoke" },
  args: [],
  inheritEnv: [],
};

try {
  await broker.start();
  connectDesktop(
    registry,
    "ada-key",
    "Ada workstation",
    createDesktopToolExecutor(host),
  );
  connectDesktop(registry, "grace-key", "Grace workstation", async () => ({
    ok: true,
    content: [{ type: "text", text: "selected Grace workstation" }],
  }));

  const originLease = broker.lease({
    key: "ada-key",
    signal: new AbortController().signal,
    originDevice: true,
  });
  const approved = await callBroker(originLease.ticket, "local_mcp_configure", {
    operation: "upsert",
    server: config,
  });
  assert.equal(approved.ok, true, "the packaged config is saved");
  assert.equal(existsSync(statePath), false, "configuration remains lazy");
  createMcpCatalogStore(join(root, "mcp-catalogs")).save(serverId, [
    {
      name: "cached_tool",
      description: "Available before the packaged fixture starts.",
      inputSchema: { type: "object" },
    },
  ]);

  const search = await callBroker(originLease.ticket, "local_mcp", {
    operation: "search",
    query: "cached",
  });
  assert.match(resultText(search), /cached_tool/, "search uses the cache");
  const describe = await callBroker(originLease.ticket, "local_mcp", {
    operation: "describe",
    serverId,
    toolName: "cached_tool",
  });
  assert.match(
    resultText(describe),
    /Available before/,
    "describe uses the cache",
  );
  assert.equal(existsSync(statePath), false, "cached reads start no child");

  const called = await callBroker(originLease.ticket, "local_mcp", {
    operation: "call",
    serverId,
    toolName: "echo",
    arguments: { message: "packaged desktop turn" },
  });
  assert.equal(called.ok, true, "the desktop-backed MCP call succeeds");
  assert.match(resultText(called), /packaged desktop turn/);
  await waitForState("start");

  const identityLease = broker.lease({
    key: "ada-key",
    signal: new AbortController().signal,
  });
  const ambiguous = await callBroker(identityLease.ticket, "local_mcp", {
    operation: "servers",
  });
  assert.equal(ambiguous.ok, false, "an identity turn refuses to guess");
  assert.match(ambiguous.error ?? "", /2 desktops connected/);
  const selected = await callBroker(identityLease.ticket, "local_mcp", {
    operation: "servers",
    desktop: "Grace workstation",
  });
  assert.match(
    resultText(selected),
    /selected Grace workstation/,
    "an explicit selector reaches the named desktop",
  );
  identityLease.revoke();

  const disabled = await callBroker(originLease.ticket, "local_mcp_configure", {
    operation: "set_enabled",
    serverId,
    enabled: false,
  });
  assert.equal(disabled.ok, true, "the packaged server disables");
  await waitForState("exit");

  const enabled = await callBroker(originLease.ticket, "local_mcp_configure", {
    operation: "set_enabled",
    serverId,
    enabled: true,
  });
  assert.equal(enabled.ok, true, "the packaged server re-enables");
  const restarted = await callBroker(originLease.ticket, "local_mcp", {
    operation: "call",
    serverId,
    toolName: "echo",
    arguments: { message: "remove a live child" },
  });
  assert.equal(restarted.ok, true, "the re-enabled server starts again");
  await waitForStateCount("start", 2);

  const removed = await callBroker(originLease.ticket, "local_mcp_configure", {
    operation: "remove",
    serverId,
  });
  assert.equal(removed.ok, true, "the packaged server removes");
  await waitForStateCount("exit", 2);
  assert.deepEqual(
    createMcpConfigStore(join(root, "mcp-servers.json")).list(),
    [],
    "removal cleans persistent config",
  );
  assert.equal(
    existsSync(join(root, "mcp-catalogs", `${serverId}.json`)),
    false,
    "removal cleans the catalog snapshot",
  );
  originLease.revoke();
  console.log("packaged MCP bridge smoke: ok");
} finally {
  broker.stop();
  registry.closeAll();
  await host.close();
  rmSync(root, { recursive: true, force: true });
}

function connectDesktop(
  target: DeviceRegistry,
  key: string,
  deviceId: string,
  execute: DesktopToolExecutor,
): void {
  target.connect({
    key,
    deviceId,
    identityId: "ada",
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      const data = match?.[1];
      if (data === undefined) return true;
      const parsed = ToolDispatchSchema.safeParse(JSON.parse(data));
      if (!parsed.success) return true;
      const dispatch = parsed.data;
      void execute(
        dispatch,
        { rootDir: root },
        new AbortController().signal,
      ).then(
        (outcome) => settle(target, key, dispatch.id, outcome),
        (error: unknown) =>
          settle(target, key, dispatch.id, {
            ok: false,
            content: [],
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return true;
    },
    end: () => undefined,
  });
}

function settle(
  target: DeviceRegistry,
  key: string,
  id: string,
  outcome: ToolCallOutcome,
): void {
  target.settleResult(key, { id, ...outcome });
}

function resultText(outcome: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function waitForState(expected: string): Promise<void> {
  await waitForStateCount(expected, 1);
}

async function waitForStateCount(
  expected: string,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matches = existsSync(statePath)
      ? readFileSync(statePath, "utf8")
          .split(/\r?\n/)
          .filter((entry) => entry === expected).length
      : 0;
    if (matches >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`packaged fixture did not record ${expected} ${count} times`);
}
