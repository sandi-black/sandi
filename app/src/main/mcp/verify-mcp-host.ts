import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpCatalogStore } from "./catalog-store";
import { createMcpConfigStore } from "./config-store";
import { ExactStdioTransport } from "./exact-stdio-transport";
import { createMcpHost, type McpConfigChange, type McpHost } from "./mcp-host";
import { protectedEnvironmentValues, redactText } from "./secret-redaction";

const fixture = join(import.meta.dirname, "fixtures", "stdio-server.mjs");
const oversizedStdoutFixture = join(
  import.meta.dirname,
  "fixtures",
  "oversized-stdout.mjs",
);
const closeResistantFixture = join(
  import.meta.dirname,
  "fixtures",
  "close-resistant.mjs",
);
const dir = mkdtempSync(join(tmpdir(), "sandi-mcp-host-"));
const statePath = join(dir, "fixture-state.log");
const refreshFailureMarker = join(dir, "refresh-failure.marker");
const secret = "fixture-secret-must-not-persist";
const previousState = process.env["SANDI_MCP_FIXTURE_STATE"];
const previousSecret = process.env["SANDI_MCP_FIXTURE_SECRET"];
const previousUnapproved = process.env["SANDI_MCP_FIXTURE_UNAPPROVED"];
const previousRefreshMarker =
  process.env["SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER"];
process.env["SANDI_MCP_FIXTURE_STATE"] = statePath;
process.env["SANDI_MCP_FIXTURE_SECRET"] = secret;
process.env["SANDI_MCP_FIXTURE_UNAPPROVED"] = "must-not-reach-child";
process.env["SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER"] = refreshFailureMarker;

const config = {
  id: "grace-fixture",
  label: "Grace Hopper fixture",
  enabled: true,
  command: { kind: "external" as const, executable: process.execPath },
  args: [fixture],
  inheritEnv: [
    "SANDI_MCP_FIXTURE_STATE",
    "SANDI_MCP_FIXTURE_SECRET",
    "SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER",
  ],
};

try {
  await verifyHost();
  console.log("verify-mcp-host: ok");
} finally {
  restoreEnv("SANDI_MCP_FIXTURE_STATE", previousState);
  restoreEnv("SANDI_MCP_FIXTURE_SECRET", previousSecret);
  restoreEnv("SANDI_MCP_FIXTURE_UNAPPROVED", previousUnapproved);
  restoreEnv("SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER", previousRefreshMarker);
  rmSync(dir, { recursive: true, force: true });
}

async function verifyHost(): Promise<void> {
  assert.equal(
    redactText(
      "abc123",
      protectedEnvironmentValues({ short: "abc", long: "abc123" }),
    ),
    "[redacted]",
    "overlapping inherited values are redacted longest-first",
  );
  await verifyConcurrentConfig();
  await verifyBundledEnvironment();
  await verifyRepeatedCursor();
  await verifyPageLimit();
  await verifySharedConnectCancellation();
  await verifySoleConnectCancellation();
  await verifyDisableDuringConnect();
  await verifyOversizedStdout();
  await verifyMalformedFrame();
  await verifyRetryableTransportClose();
  await verifyOversizedCachedCatalog();
  await verifyWindowsCommandScript();
  let host = createMcpHost({ userDataDir: dir });
  const cancelledHost = createMcpHost({
    userDataDir: join(dir, "cancelled-config"),
  });
  const configController = new AbortController();
  configController.abort(new Error("turn cancelled before configuration"));
  const cancelledChange = configure(
    cancelledHost,
    { operation: "upsert", server: config },
    configController.signal,
  );
  assert.equal(
    (await cancelledChange).ok,
    false,
    "a cancelled turn cannot persist configuration",
  );
  assert.equal(
    existsSync(join(dir, "cancelled-config", "mcp-servers.json")),
    false,
    "cancellation leaves config untouched",
  );
  await cancelledHost.close();

  const approved = await configure(host, {
    operation: "upsert",
    server: config,
  });
  assert.equal(approved.ok, true, "config is saved");
  assert.equal(
    existsSync(statePath),
    false,
    "config remains lazy after persistence",
  );
  await host.close();

  const catalogStore = createMcpCatalogStore(join(dir, "mcp-catalogs"));
  catalogStore.save(config.id, [
    {
      name: "cached_tool",
      title: "Cached tool",
      description: "Loaded without spawning the fixture.",
      inputSchema: { type: "object" },
    },
    {
      name: "large_schema",
      description: "Large but valid cached schema.",
      inputSchema: { type: "object", description: "x".repeat(60_000) },
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      name: `described_${index}`,
      description: "x".repeat(2_000),
      inputSchema: { type: "object" },
    })),
  ]);
  host = createMcpHost({ userDataDir: dir });
  const cached = await mcp(host, {
    operation: "search",
    query: "cached",
  });
  assert.equal(cached.ok, true, "cached search succeeds");
  assert.match(text(cached), /cached_tool/, "cached search returns its tool");
  assert.equal(existsSync(statePath), false, "cached search starts no process");
  const described = await mcp(host, {
    operation: "describe",
    serverId: config.id,
    toolName: "cached_tool",
  });
  assert.match(
    text(described),
    /Loaded without spawning/,
    "describe uses cache",
  );
  assert.equal(
    (
      await mcp(host, {
        operation: "describe",
        serverId: config.id,
        toolName: "large_schema",
      })
    ).ok,
    true,
    "the largest valid schema remains describable",
  );
  assert.equal(
    (
      await mcp(host, {
        operation: "search",
        query: "",
        serverId: config.id,
      })
    ).ok,
    true,
    "a full search page of maximum descriptions remains usable",
  );

  const [first, second] = await Promise.all([
    mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "Ada" },
    }),
    mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "Grace" },
    }),
  ]);
  assert.equal(
    countState("start"),
    1,
    "simultaneous first calls share one child",
  );
  assert.deepEqual(
    first.content.map((block) => block.type),
    ["text", "image", "text"],
    "MCP result content order is preserved",
  );
  assert.equal(
    first.structuredContent?.["secretPresent"],
    true,
    "configured environment names are resolved on the desktop",
  );
  assert.equal(
    first.structuredContent?.["secretEcho"],
    "[redacted]",
    "inherited values are redacted from structured results",
  );
  assert.equal(
    first.structuredContent?.["unapprovedPresent"],
    false,
    "an uninherited desktop variable is absent from the child environment",
  );
  assert.match(text(second), /Grace/, "concurrent calls keep their own result");
  assert.equal(
    JSON.stringify([first, second]).includes(secret),
    false,
    "inherited values are redacted from tool content",
  );
  assert.equal(
    readFileSync(
      join(dir, "mcp-catalogs", `${config.id}.json`),
      "utf8",
    ).includes(secret),
    false,
    "inherited values are redacted before catalog persistence",
  );

  const invalidOutput = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "invalid_output",
    arguments: {},
  });
  assert.equal(invalidOutput.ok, false, "invalid MCP structured output fails");
  assert.match(
    invalidOutput.error ?? "",
    /invalid structured content/,
    "output schemas from an earlier catalog page remain enforced",
  );

  const secretError = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "secret_error",
    arguments: {},
  });
  assert.equal(secretError.ok, false, "MCP protocol errors fail the call");
  assert.equal(
    (secretError.error ?? "").includes(secret),
    false,
    "inherited values are redacted from MCP protocol errors",
  );
  assert.match(secretError.error ?? "", /\[redacted\]/);

  const armedRefreshFailure = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "fail_catalog_with_secret",
    arguments: {},
  });
  assert.equal(
    armedRefreshFailure.ok,
    true,
    "the catalog failure fixture arms",
  );
  const refreshFailure = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: { message: "unreachable" },
  });
  assert.equal(
    refreshFailure.ok,
    false,
    "a repeated catalog failure is returned",
  );
  assert.equal(
    (refreshFailure.error ?? "").includes(secret),
    false,
    "inherited values are redacted from catalog refresh errors",
  );
  assert.match(refreshFailure.error ?? "", /\[redacted\]/);
  assert.equal(
    readFileSync(refreshFailureMarker, "utf8"),
    "3",
    "the regression reaches the post-reconnect refresh failure",
  );
  rmSync(refreshFailureMarker, { force: true });

  const oversized = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "oversized_structured",
    arguments: {},
  });
  assert.equal(oversized.ok, false, "oversized structured output is refused");
  assert.match(
    oversized.error ?? "",
    /result limits/,
    "oversized structured output returns a bounded error",
  );

  const pagedSearch = await mcp(host, {
    operation: "search",
    query: "wait",
    serverId: config.id,
  });
  assert.match(
    text(pagedSearch),
    /"wait"/,
    "catalog pagination reaches page two",
  );

  const startsBeforeCrash = countState("start");
  const exitsBeforeCrash = countState("exit");
  await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "add_tool",
    arguments: {},
  });
  await waitFor(async () => {
    const outcome = await mcp(host, {
      operation: "search",
      query: "extra",
      serverId: config.id,
    });
    return text(outcome).includes("extra");
  });
  const listCount = countState("list-start");
  await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "notify_storm",
    arguments: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitFor(() =>
    Promise.resolve(countState("list-start") >= listCount + 3),
  );
  assert.equal(
    countState("list-start"),
    listCount + 3,
    "catalog notifications coalesce and retain one trailing refresh",
  );

  const controller = new AbortController();
  const waiting = mcp(
    host,
    {
      operation: "call",
      serverId: config.id,
      toolName: "wait",
      arguments: {},
    },
    controller.signal,
  );
  await waitFor(() => Promise.resolve(state().includes("call:wait")));
  controller.abort(new Error("fixture cancellation"));
  const cancelled = await waiting;
  assert.equal(
    cancelled.ok,
    false,
    "cancelled MCP request is not reported as success",
  );
  await waitFor(() => Promise.resolve(state().includes("cancelled:wait")));

  await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "crash",
    arguments: {},
  });
  await waitFor(() => Promise.resolve(countState("exit") > exitsBeforeCrash));
  const reconnected = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: { message: "reconnected" },
  });
  assert.equal(
    reconnected.ok,
    true,
    "a later call reconnects after transport close",
  );
  assert.equal(
    countState("start"),
    startsBeforeCrash + 1,
    "transport close creates one new child",
  );

  const exitsBeforeDisable = countState("exit");
  const startsBeforeEnable = countState("start");
  await configure(host, {
    operation: "set_enabled",
    serverId: config.id,
    enabled: false,
  });
  await waitFor(() => Promise.resolve(countState("exit") > exitsBeforeDisable));
  const disabled = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: {},
  });
  assert.equal(disabled.ok, false, "disabled server cannot start");

  await configure(host, {
    operation: "set_enabled",
    serverId: config.id,
    enabled: true,
  });
  await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: { message: "enabled" },
  });
  assert.equal(
    countState("start"),
    startsBeforeEnable + 1,
    "re-enabling remains lazy until call",
  );
  const exitsBeforeReplace = countState("exit");
  await configure(host, { operation: "upsert", server: config });
  await waitFor(() => Promise.resolve(countState("exit") > exitsBeforeReplace));
  await configure(host, { operation: "remove", serverId: config.id });
  assert.equal(
    existsSync(join(dir, "mcp-catalogs", `${config.id}.json`)),
    false,
    "remove cleans the catalog snapshot",
  );

  const bundled = {
    ...config,
    command: { kind: "bundled" as const, id: "missing" },
  };
  await configure(host, { operation: "upsert", server: bundled });
  const unavailable = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: {},
  });
  assert.match(
    unavailable.error ?? "",
    /unavailable in this build/,
    "unknown bundled ids fail before spawn",
  );
  assert.equal(
    countState("start"),
    startsBeforeEnable + 1,
    "unavailable bundled id starts no child",
  );

  await host.close();
  await waitFor(() => Promise.resolve(countState("exit") >= 3));
  const persisted = readPersistedText(dir);
  assert.equal(
    persisted.includes(secret),
    false,
    "desktop secret is never persisted",
  );
  assert.throws(
    () =>
      catalogStore.save(
        "too-large",
        Array.from({ length: 501 }, (_, index) => ({
          name: `tool-${index}`,
          inputSchema: { type: "object" },
        })),
      ),
    /Too big|too_big|500|array/i,
    "over-limit catalogs fail closed",
  );
  assert.throws(
    () =>
      catalogStore.save(
        "aggregate-too-large",
        Array.from({ length: 500 }, (_, index) => ({
          name: `tool-${index}`,
          description: "x".repeat(2_000),
          inputSchema: {
            type: "object",
            description: "x".repeat(7_000),
          },
        })),
      ),
    /4 MiB/,
    "aggregate catalog snapshots are bounded",
  );
}

async function verifyConcurrentConfig(): Promise<void> {
  const root = join(dir, "concurrent-config");
  const host = createMcpHost({ userDataDir: root });
  await Promise.all([
    configure(host, {
      operation: "upsert",
      server: { ...config, id: "ada" },
    }),
    configure(host, {
      operation: "upsert",
      server: { ...config, id: "grace" },
    }),
  ]);
  assert.deepEqual(
    createMcpConfigStore(join(root, "mcp-servers.json"))
      .list()
      .map((server) => server.id)
      .sort(),
    ["ada", "grace"],
    "concurrent changes serialize without stale config writes",
  );
  await host.close();
}

async function verifyBundledEnvironment(): Promise<void> {
  const root = join(dir, "bundled-env");
  const bundledState = join(root, "state.log");
  const host = createMcpHost({
    userDataDir: root,
    resolveBundled: (id) =>
      id === "fixture"
        ? {
            executable: process.execPath,
            argsPrefix: [fixture],
            env: {
              PATH: "bundled-path",
              SANDI_MCP_FIXTURE_STATE: bundledState,
            },
          }
        : undefined,
  });
  await configure(host, {
    operation: "upsert",
    server: {
      ...config,
      command: { kind: "bundled", id: "fixture" },
      args: [],
      inheritEnv: ["PATH", "SANDI_MCP_FIXTURE_SECRET"],
    },
  });
  const outcome = await mcp(host, {
    operation: "call",
    serverId: config.id,
    toolName: "echo",
    arguments: { message: "bundled" },
  });
  assert.equal(
    outcome.structuredContent?.["secretPresent"],
    true,
    "bundled commands receive configured inherited variables",
  );
  assert.equal(
    outcome.structuredContent?.["pathValue"],
    "bundled-path",
    "bundled commands preserve registry-owned environment variables",
  );
  await host.close();
  await waitFor(() =>
    Promise.resolve(readFileSync(bundledState, "utf8").includes("exit")),
  );
}

async function verifyRepeatedCursor(): Promise<void> {
  const root = join(dir, "repeated-cursor");
  const repeatedState = join(root, "state.log");
  const previous = process.env["SANDI_MCP_FIXTURE_REPEAT_CURSOR"];
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_REPEAT_CURSOR"] = "1";
  process.env["SANDI_MCP_FIXTURE_STATE"] = repeatedState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: [
          "SANDI_MCP_FIXTURE_REPEAT_CURSOR",
          "SANDI_MCP_FIXTURE_STATE",
        ],
      },
    });
    const outcome = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "loop" },
    });
    assert.match(
      outcome.error ?? "",
      /repeated a pagination cursor/,
      "repeated pagination cursors fail promptly",
    );
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_REPEAT_CURSOR", previous);
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifySharedConnectCancellation(): Promise<void> {
  const root = join(dir, "connect-cancellation");
  const connectionState = join(root, "state.log");
  const previousDelay = process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"];
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"] = "100";
  process.env["SANDI_MCP_FIXTURE_STATE"] = connectionState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: [
          "SANDI_MCP_FIXTURE_LIST_DELAY_MS",
          "SANDI_MCP_FIXTURE_STATE",
        ],
      },
    });
    const firstController = new AbortController();
    const first = mcp(
      host,
      {
        operation: "call",
        serverId: config.id,
        toolName: "echo",
        arguments: { message: "cancelled waiter" },
      },
      firstController.signal,
    );
    const second = mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "remaining waiter" },
    });
    await waitFor(() => Promise.resolve(fileIncludes(connectionState, "list")));
    firstController.abort(new Error("first waiter cancelled"));
    assert.equal((await first).ok, false, "a cancelled connect waiter settles");
    assert.equal(
      (await second).ok,
      true,
      "one cancelled waiter does not tear down a shared connection",
    );
    assert.equal(
      readFileSync(connectionState, "utf8")
        .split(/\r?\n/)
        .filter((line) => line === "start").length,
      1,
      "shared connection initialization starts one child",
    );
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_LIST_DELAY_MS", previousDelay);
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifyPageLimit(): Promise<void> {
  const root = join(dir, "page-limit");
  const pageState = join(root, "state.log");
  const previousPages = process.env["SANDI_MCP_FIXTURE_UNBOUNDED_PAGES"];
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_UNBOUNDED_PAGES"] = "1";
  process.env["SANDI_MCP_FIXTURE_STATE"] = pageState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: [
          "SANDI_MCP_FIXTURE_UNBOUNDED_PAGES",
          "SANDI_MCP_FIXTURE_STATE",
        ],
      },
    });
    const outcome = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: {},
    });
    assert.match(
      outcome.error ?? "",
      /exceeds 500 pages/,
      "fresh empty cursors cannot create unbounded pagination",
    );
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_UNBOUNDED_PAGES", previousPages);
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifyDisableDuringConnect(): Promise<void> {
  const root = join(dir, "disable-during-connect");
  const connectionState = join(root, "state.log");
  const previousDelay = process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"];
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"] = "100";
  process.env["SANDI_MCP_FIXTURE_STATE"] = connectionState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: [
          "SANDI_MCP_FIXTURE_LIST_DELAY_MS",
          "SANDI_MCP_FIXTURE_STATE",
        ],
      },
    });
    const connecting = mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "racing disable" },
    });
    await waitFor(() => Promise.resolve(fileIncludes(connectionState, "list")));
    await configure(host, {
      operation: "set_enabled",
      serverId: config.id,
      enabled: false,
    });
    assert.equal(
      (await connecting).ok,
      false,
      "disabling during connection startup cancels the pending call",
    );
    await waitFor(() => Promise.resolve(fileIncludes(connectionState, "exit")));
    const disabled = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: {},
    });
    assert.equal(
      disabled.ok,
      false,
      "the raced disable leaves no live command",
    );
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_LIST_DELAY_MS", previousDelay);
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifySoleConnectCancellation(): Promise<void> {
  const root = join(dir, "sole-connect-cancellation");
  const connectionState = join(root, "state.log");
  const previousDelay = process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"];
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"] = "100";
  process.env["SANDI_MCP_FIXTURE_STATE"] = connectionState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: [
          "SANDI_MCP_FIXTURE_LIST_DELAY_MS",
          "SANDI_MCP_FIXTURE_STATE",
        ],
      },
    });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new Error("cancelled before call"));
    assert.equal(
      (
        await mcp(
          host,
          {
            operation: "call",
            serverId: config.id,
            toolName: "echo",
            arguments: {},
          },
          alreadyCancelled.signal,
        )
      ).ok,
      false,
      "an already-cancelled call is refused",
    );
    assert.equal(
      existsSync(connectionState),
      false,
      "an already-cancelled call starts no child",
    );
    const controller = new AbortController();
    const connecting = mcp(
      host,
      {
        operation: "call",
        serverId: config.id,
        toolName: "echo",
        arguments: { message: "cancel initialization" },
      },
      controller.signal,
    );
    await waitFor(() => Promise.resolve(fileIncludes(connectionState, "list")));
    controller.abort(new Error("sole connect waiter cancelled"));
    assert.equal((await connecting).ok, false, "a sole connect waiter cancels");
    await waitFor(() => Promise.resolve(fileIncludes(connectionState, "exit")));
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_LIST_DELAY_MS", previousDelay);
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifyOversizedStdout(): Promise<void> {
  const root = join(dir, "oversized-stdout");
  const stdoutState = join(root, "state.log");
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_STATE"] = stdoutState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        args: [oversizedStdoutFixture],
        inheritEnv: ["SANDI_MCP_FIXTURE_STATE"],
      },
    });
    const outcome = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: {},
    });
    assert.equal(outcome.ok, false, "oversized unterminated stdout is refused");
    const pidLine = readFileSync(stdoutState, "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("pid:"));
    assert.ok(pidLine, "oversized stdout fixture records its process id");
    const pid = Number(pidLine.slice(4));
    await waitFor(() => Promise.resolve(!isProcessAlive(pid)));
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifyOversizedCachedCatalog(): Promise<void> {
  const root = join(dir, "oversized-cached-catalog");
  const catalogDirectory = join(root, "mcp-catalogs");
  mkdirSync(catalogDirectory, { recursive: true });
  writeFileSync(
    join(catalogDirectory, "oversized.json"),
    "x".repeat(8 * 1024 * 1024 + 1),
    "utf8",
  );
  const store = createMcpCatalogStore(catalogDirectory);
  assert.equal(
    store.load("oversized"),
    undefined,
    "oversized cached catalogs are rejected before reading",
  );
  assert.equal(
    existsSync(join(catalogDirectory, "oversized.json")),
    false,
    "oversized cached catalogs are quarantined",
  );
}

async function verifyMalformedFrame(): Promise<void> {
  const root = join(dir, "malformed-frame");
  const malformedState = join(root, "state.log");
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_STATE"] = malformedState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        inheritEnv: ["SANDI_MCP_FIXTURE_STATE", "SANDI_MCP_FIXTURE_SECRET"],
      },
    });
    const malformedFrame = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "malformed_frame",
      arguments: {},
    });
    assert.equal(
      malformedFrame.ok,
      false,
      "malformed MCP frames fail the call",
    );
    const afterMalformedFrame = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "after malformed frame" },
    });
    assert.equal(
      afterMalformedFrame.ok,
      true,
      "a call after a malformed frame reconnects",
    );
    assert.equal(
      readFileSync(malformedState, "utf8")
        .split(/\r?\n/)
        .filter((line) => line === "start").length,
      2,
      "a malformed frame retires its process",
    );
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

async function verifyRetryableTransportClose(): Promise<void> {
  const transport = new ExactStdioTransport({
    executable: process.execPath,
    args: [closeResistantFixture],
    env: {},
  });
  await transport.start();
  const child: unknown = Reflect.get(transport, "child");
  assert.ok(child instanceof ChildProcess, "transport owns its live child");
  const pid = child.pid;
  assert.ok(pid !== undefined, "transport child has a process id");
  const kill = child.kill.bind(child);
  let failFirstKill = true;
  child.kill = (signal) => {
    if (failFirstKill) {
      failFirstKill = false;
      throw new Error("simulated close failure");
    }
    return kill(signal);
  };
  await assert.rejects(
    transport.close(),
    /simulated close failure/,
    "a process-close failure reaches the owner",
  );
  assert.equal(
    transport.pid,
    pid,
    "a failed close retains the child for another attempt",
  );
  await transport.close();
  await waitFor(() => Promise.resolve(!isProcessAlive(pid)));
  assert.equal(transport.pid, null, "a successful retry releases the child");
}

async function verifyWindowsCommandScript(): Promise<void> {
  if (process.platform !== "win32") return;
  const root = join(dir, "windows-command-script");
  mkdirSync(root, { recursive: true });
  const commandPath = join(root, "fixture.cmd");
  const commandState = join(root, "state.log");
  writeFileSync(
    commandPath,
    `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`,
    "utf8",
  );
  const previousStatePath = process.env["SANDI_MCP_FIXTURE_STATE"];
  process.env["SANDI_MCP_FIXTURE_STATE"] = commandState;
  const host = createMcpHost({ userDataDir: root });
  try {
    await configure(host, {
      operation: "upsert",
      server: {
        ...config,
        command: { kind: "external", executable: commandPath },
        args: [],
        inheritEnv: ["SANDI_MCP_FIXTURE_STATE"],
      },
    });
    const outcome = await mcp(host, {
      operation: "call",
      serverId: config.id,
      toolName: "echo",
      arguments: { message: "command script" },
    });
    assert.equal(outcome.ok, true, "Windows command scripts launch as MCPs");
  } finally {
    await host.close();
    restoreEnv("SANDI_MCP_FIXTURE_STATE", previousStatePath);
  }
}

function mcp(
  host: McpHost,
  params:
    | { operation: "servers" }
    | { operation: "search"; query: string; serverId?: string }
    | { operation: "describe"; serverId: string; toolName: string }
    | {
        operation: "call";
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
      },
  signal = new AbortController().signal,
) {
  return host.execute({ tool: "local_mcp", params }, signal);
}

function configure(
  host: McpHost,
  params: McpConfigChange,
  signal = new AbortController().signal,
) {
  return host.execute({ tool: "local_mcp_configure", params }, signal);
}

function text(outcome: Awaited<ReturnType<typeof mcp>>): string {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function state(): string {
  return existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
}

function fileIncludes(path: string, text: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(text);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countState(line: string): number {
  return state()
    .split(/\r?\n/)
    .filter((entry) => entry === line).length;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

function readPersistedText(root: string): string {
  const files = [
    join(root, "mcp-servers.json"),
    join(root, "mcp-catalogs", `${config.id}.json`),
    statePath,
  ];
  return files
    .filter(existsSync)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
