import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  type CatalogTool,
  catalogToolBytes,
  createMcpCatalogStore,
  MAX_MCP_CATALOG_BYTES,
  type McpCatalog,
  type McpCatalogStore,
  parseCatalogTool,
} from "./catalog-store";
import { createMcpConfigStore, type McpConfigStore } from "./config-store";
import { ExactStdioTransport } from "./exact-stdio-transport";
import { convertMcpToolResult } from "./result-converter";
import {
  protectedEnvironmentValues,
  redactText,
  redactValue,
} from "./secret-redaction";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  DesktopMcpServerConfig,
  LocalMcpConfigureParams,
  LocalMcpParams,
} from "@sandi-server/surfaces/api/devices/mcp-protocol";
import type {
  BrokerCall,
  ToolCallOutcome,
} from "@sandi-server/surfaces/api/devices/protocol";
import {
  DeviceContentListSchema,
  MAX_DEVICE_ERROR_CHARS,
} from "@sandi-server/surfaces/api/devices/protocol";

export type McpConfigChange = LocalMcpConfigureParams;
export type BundledMcpCommand = {
  id?: string;
  version?: string;
  manifestSha256?: string;
  executable: string;
  argsPrefix: string[];
  argsSuffix?: string[];
  cwd?: string;
  env?: Record<string, string>;
};
type ResolvedMcpCommand = BundledMcpCommand & {
  protectedValues: string[];
};
export type McpHost = {
  execute(call: BrokerCall, signal: AbortSignal): Promise<ToolCallOutcome>;
  close(): Promise<void>;
};

type LiveConnection = {
  token: string;
  client: Client;
  transport: ExactStdioTransport;
  protectedValues: string[];
  callMetadata: Map<string, ToolCallMetadata>;
};

type ToolCallMetadata = {
  rawName: string;
  outputSchema?: CatalogTool["outputSchema"];
  taskSupport?: "optional" | "required" | "forbidden";
};

type ConnectionEntry = {
  token: string;
  controller: AbortController;
  promise: Promise<LiveConnection>;
  waiters: number;
  settled: boolean;
};

export function createMcpHost(input: {
  userDataDir: string;
  resolveBundled?: (
    id: string,
    configuredArgs: readonly string[],
  ) => BundledMcpCommand | undefined | Promise<BundledMcpCommand | undefined>;
  configStore?: McpConfigStore;
  catalogStore?: McpCatalogStore;
}): McpHost {
  const configStore =
    input.configStore ??
    createMcpConfigStore(join(input.userDataDir, "mcp-servers.json"));
  const catalogStore =
    input.catalogStore ??
    createMcpCatalogStore(join(input.userDataDir, "mcp-catalogs"));
  const catalogs = new Map<string, McpCatalog>();
  const connections = new Map<string, ConnectionEntry>();
  const connectionTokens = new Map<string, string>();
  const lastErrors = new Map<string, string>();
  const outputSchemaValidator = new AjvJsonSchemaValidator();
  const notificationWorkers = new Map<string, Promise<void>>();
  const notificationGenerations = new Map<string, number>();
  const notificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let configTail = Promise.resolve();

  const serializeConfig = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = configTail.then(run, run);
    configTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const configFor = (serverId: string): DesktopMcpServerConfig | undefined =>
    configStore.list().find((server) => server.id === serverId);

  const catalogFor = (serverId: string): McpCatalog | undefined => {
    const cached = catalogs.get(serverId);
    if (cached) return cached;
    const loaded = catalogStore.load(serverId);
    if (loaded) catalogs.set(serverId, loaded);
    return loaded;
  };

  const closeServer = async (serverId: string): Promise<void> => {
    const pending = connections.get(serverId);
    connections.delete(serverId);
    connectionTokens.delete(serverId);
    const notificationTimer = notificationTimers.get(serverId);
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimers.delete(serverId);
    notificationGenerations.delete(serverId);
    if (!pending) return;
    pending.controller.abort(new Error("desktop MCP server is closing"));
    let live: LiveConnection;
    try {
      live = await pending.promise;
    } catch {
      // A failed connect owns no reusable process. Its original error is
      // already returned to the caller that started it.
      return;
    }
    try {
      await live.client.close();
    } catch {
      await live.transport.close();
    }
  };

  const refreshCatalog = async (
    serverId: string,
    client: Client,
    protectedValues: string[],
    callMetadata: Map<string, ToolCallMetadata>,
    signal?: AbortSignal,
  ): Promise<McpCatalog> => {
    const tools: CatalogTool[] = [];
    const nextCallMetadata = new Map<string, ToolCallMetadata>();
    let catalogBytes = 0;
    const seenCursors = new Set<string>();
    let pageCount = 0;
    let cursor: string | undefined;
    do {
      pageCount += 1;
      if (pageCount > 500) {
        throw new Error("desktop MCP catalog exceeds 500 pages");
      }
      const page = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        signal === undefined ? undefined : { signal },
      );
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error("desktop MCP catalog repeated a pagination cursor");
        }
        seenCursors.add(cursor);
      }
      for (const tool of page.tools) {
        const raw = parseCatalogTool({
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          ...(tool.description !== undefined
            ? { description: tool.description }
            : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema !== undefined
            ? { outputSchema: tool.outputSchema }
            : {}),
          ...(tool.execution !== undefined
            ? { execution: tool.execution }
            : {}),
          ...(tool.annotations !== undefined
            ? { annotations: tool.annotations }
            : {}),
        });
        const parsed = parseCatalogTool(redactValue(raw, protectedValues));
        if (nextCallMetadata.has(parsed.name)) {
          throw new Error(
            "desktop MCP catalog contains tool names that collide after redaction",
          );
        }
        nextCallMetadata.set(parsed.name, {
          rawName: raw.name,
          ...(raw.outputSchema !== undefined
            ? { outputSchema: raw.outputSchema }
            : {}),
          ...(raw.execution?.taskSupport !== undefined
            ? { taskSupport: raw.execution.taskSupport }
            : {}),
        });
        catalogBytes += catalogToolBytes(parsed);
        if (catalogBytes > MAX_MCP_CATALOG_BYTES) {
          throw new Error("desktop MCP catalog exceeds 4 MiB");
        }
        tools.push(parsed);
      }
      if (tools.length > 500) {
        throw new Error("desktop MCP catalog exceeds 500 tools");
      }
    } while (cursor !== undefined);
    const names = new Set(tools.map((tool) => tool.name));
    if (names.size !== tools.length) {
      throw new Error("desktop MCP catalog contains duplicate tool names");
    }
    const catalog = catalogStore.save(serverId, tools);
    catalogs.set(serverId, catalog);
    callMetadata.clear();
    for (const [name, metadata] of nextCallMetadata) {
      callMetadata.set(name, metadata);
    }
    lastErrors.delete(serverId);
    return catalog;
  };

  const runNotificationRefreshes = (
    serverId: string,
    client: Client,
    protectedValues: string[],
    callMetadata: Map<string, ToolCallMetadata>,
    signal: AbortSignal,
  ): void => {
    if (notificationWorkers.has(serverId)) return;
    const worker = (async () => {
      for (;;) {
        const generation = notificationGenerations.get(serverId) ?? 0;
        await refreshCatalog(
          serverId,
          client,
          protectedValues,
          callMetadata,
          signal,
        );
        if ((notificationGenerations.get(serverId) ?? 0) === generation) return;
      }
    })();
    notificationWorkers.set(serverId, worker);
    void worker
      .catch((error: unknown) => {
        if (!signal.aborted) {
          lastErrors.set(serverId, boundedError(error, protectedValues));
        }
      })
      .finally(() => {
        if (notificationWorkers.get(serverId) === worker) {
          notificationWorkers.delete(serverId);
        }
      });
  };

  const scheduleNotificationRefresh = (
    serverId: string,
    client: Client,
    protectedValues: string[],
    callMetadata: Map<string, ToolCallMetadata>,
    signal: AbortSignal,
  ): void => {
    notificationGenerations.set(
      serverId,
      (notificationGenerations.get(serverId) ?? 0) + 1,
    );
    const existing = notificationTimers.get(serverId);
    if (existing) clearTimeout(existing);
    notificationTimers.set(
      serverId,
      setTimeout(() => {
        notificationTimers.delete(serverId);
        runNotificationRefreshes(
          serverId,
          client,
          protectedValues,
          callMetadata,
          signal,
        );
      }, 50),
    );
  };

  const commandFor = async (
    config: DesktopMcpServerConfig,
  ): Promise<ResolvedMcpCommand> => {
    const inheritedEnv: Record<string, string> = {};
    for (const name of config.inheritEnv) {
      const value = process.env[name];
      if (value !== undefined) inheritedEnv[name] = value;
    }
    if (config.command.kind === "external") {
      return {
        executable: config.command.executable,
        argsPrefix: [],
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        env: inheritedEnv,
        protectedValues: protectedEnvironmentValues(inheritedEnv),
      };
    }
    const resolved = await input.resolveBundled?.(
      config.command.id,
      config.args,
    );
    if (!resolved) {
      throw new Error(
        `bundled MCP command ${config.command.id} is unavailable in this build`,
      );
    }
    return {
      ...resolved,
      env: { ...inheritedEnv, ...resolved.env },
      protectedValues: protectedEnvironmentValues(inheritedEnv),
    };
  };

  const connectionEntry = (serverId: string): ConnectionEntry => {
    const existing = connections.get(serverId);
    if (existing) return existing;
    const config = configFor(serverId);
    if (!config)
      throw new Error(`desktop MCP server ${serverId} is not configured`);
    if (!config.enabled)
      throw new Error(`desktop MCP server ${serverId} is disabled`);
    const token = randomUUID();
    const controller = new AbortController();
    connectionTokens.set(serverId, token);
    const promise = (async (): Promise<LiveConnection> => {
      const command = await commandFor(config);
      const protectedValues = command.protectedValues;
      const callMetadata = new Map<string, ToolCallMetadata>();
      const client = new Client(
        { name: "sandi-desktop", version: "0.1.0" },
        {
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => {
                scheduleNotificationRefresh(
                  serverId,
                  client,
                  protectedValues,
                  callMetadata,
                  controller.signal,
                );
              },
            },
          },
        },
      );
      const cwd = command.cwd ?? config.cwd;
      const transport = new ExactStdioTransport({
        executable: command.executable,
        args: [
          ...command.argsPrefix,
          ...config.args,
          ...(command.argsSuffix ?? []),
        ],
        env: command.env ?? {},
        ...(cwd !== undefined ? { cwd } : {}),
      });
      transport.stderr.on("data", () => undefined);
      client.onclose = () => {
        if (connectionTokens.get(serverId) === token) {
          connections.delete(serverId);
          connectionTokens.delete(serverId);
        }
      };
      client.onerror = (error) => {
        lastErrors.set(serverId, boundedError(error, protectedValues));
      };
      try {
        await client.connect(transport, { signal: controller.signal });
        await refreshCatalog(
          serverId,
          client,
          protectedValues,
          callMetadata,
          controller.signal,
        );
        return { token, client, transport, protectedValues, callMetadata };
      } catch (error) {
        const bounded = boundedError(error, protectedValues);
        lastErrors.set(serverId, bounded);
        await transport.close().catch(() => undefined);
        throw new Error(bounded);
      }
    })();
    const entry: ConnectionEntry = {
      token,
      controller,
      promise,
      waiters: 0,
      settled: false,
    };
    connections.set(serverId, entry);
    void promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    void promise.catch(() => {
      if (connectionTokens.get(serverId) === token) {
        connections.delete(serverId);
        connectionTokens.delete(serverId);
      }
    });
    return entry;
  };

  const connect = async (
    serverId: string,
    signal: AbortSignal,
  ): Promise<LiveConnection> => {
    signal.throwIfAborted();
    const entry = await serializeConfig(() => {
      signal.throwIfAborted();
      const existing = connections.get(serverId);
      if (existing?.controller.signal.aborted) {
        connections.delete(serverId);
        connectionTokens.delete(serverId);
      }
      return connectionEntry(serverId);
    });
    const live = await waitForConnection(entry, signal);
    if (live.transport.pid !== null) return live;
    await serializeConfig(() => {
      if (connections.get(serverId) === entry) {
        connections.delete(serverId);
        connectionTokens.delete(serverId);
      }
    });
    return connect(serverId, signal);
  };

  const configure = async (
    change: LocalMcpConfigureParams,
    signal: AbortSignal,
  ): Promise<ToolCallOutcome> => {
    signal.throwIfAborted();
    return serializeConfig(async () => {
      signal.throwIfAborted();
      const servers = configStore.list();
      if (change.operation === "upsert") {
        await closeServer(change.server.id);
        signal.throwIfAborted();
        configStore.save([
          ...servers.filter((server) => server.id !== change.server.id),
          change.server,
        ]);
        catalogs.delete(change.server.id);
        catalogStore.remove(change.server.id);
        return textOutcome(`saved desktop MCP server ${change.server.id}`);
      }
      const existing = servers.find((server) => server.id === change.serverId);
      if (!existing) {
        return {
          ok: false,
          content: [],
          error: `desktop MCP server ${change.serverId} is not configured`,
        };
      }
      await closeServer(change.serverId);
      signal.throwIfAborted();
      if (change.operation === "remove") {
        configStore.save(
          servers.filter((server) => server.id !== change.serverId),
        );
        catalogs.delete(change.serverId);
        catalogStore.remove(change.serverId);
        lastErrors.delete(change.serverId);
        return textOutcome(`removed desktop MCP server ${change.serverId}`);
      }
      configStore.save(
        servers.map((server) =>
          server.id === change.serverId
            ? { ...server, enabled: change.enabled }
            : server,
        ),
      );
      return textOutcome(
        `${change.enabled ? "enabled" : "disabled"} desktop MCP server ${change.serverId}`,
      );
    });
  };

  const prepareCall = async (
    serverId: string,
    signal: AbortSignal,
  ): Promise<{ live: LiveConnection; catalog: McpCatalog }> => {
    const live = await connect(serverId, signal);
    try {
      return {
        live,
        catalog: await refreshCatalog(
          serverId,
          live.client,
          live.protectedValues,
          live.callMetadata,
          signal,
        ),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      await serializeConfig(async () => {
        const current = connections.get(serverId);
        if (current?.token === live.token) await closeServer(serverId);
      });
      const reconnected = await connect(serverId, signal);
      try {
        return {
          live: reconnected,
          catalog: await refreshCatalog(
            serverId,
            reconnected.client,
            reconnected.protectedValues,
            reconnected.callMetadata,
            signal,
          ),
        };
      } catch (refreshError) {
        throw new Error(
          boundedError(refreshError, reconnected.protectedValues),
        );
      }
    }
  };

  const read = async (
    params: LocalMcpParams,
    signal: AbortSignal,
  ): Promise<ToolCallOutcome> => {
    if (params.operation === "servers") {
      const servers = configStore.list().map((server) => ({
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        catalog: catalogFor(server.id)
          ? "cached"
          : connections.has(server.id)
            ? "connecting"
            : "missing",
        ...(lastErrors.get(server.id) !== undefined
          ? { lastError: lastErrors.get(server.id) }
          : {}),
      }));
      return jsonOutcome({ servers });
    }
    if (params.operation === "search") {
      const query = params.query.trim().toLowerCase();
      const matches = configStore
        .list()
        .filter((server) =>
          params.serverId === undefined ? true : server.id === params.serverId,
        )
        .flatMap((server) =>
          (catalogFor(server.id)?.tools ?? []).map((tool) => ({
            server,
            tool,
          })),
        )
        .map(({ server, tool }) => ({
          serverId: server.id,
          toolName: tool.name,
          title: tool.title ?? tool.annotations?.title ?? tool.name,
          description: tool.description ?? "",
          score: searchScore(query, tool),
        }))
        .filter((match) => query.length === 0 || match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.serverId.localeCompare(right.serverId) ||
            left.toolName.localeCompare(right.toolName),
        )
        .slice(0, params.limit ?? 10)
        .map(({ score: _score, ...match }) => match);
      return jsonOutcome({ matches });
    }
    const catalog = catalogFor(params.serverId);
    const tool = catalog?.tools.find((entry) => entry.name === params.toolName);
    if (params.operation === "describe") {
      return tool
        ? jsonOutcome({ serverId: params.serverId, tool })
        : missingTool(params.serverId, params.toolName);
    }
    const prepared = await prepareCall(params.serverId, signal);
    const { live, catalog: fresh } = prepared;
    const freshTool = fresh.tools.find(
      (entry) => entry.name === params.toolName,
    );
    if (!freshTool) {
      return missingTool(params.serverId, params.toolName);
    }
    const metadata = live.callMetadata.get(params.toolName);
    if (!metadata) {
      return missingTool(params.serverId, params.toolName);
    }
    if (metadata.taskSupport === "required") {
      return {
        ok: false,
        content: [],
        error: `desktop MCP tool ${params.serverId}/${params.toolName} requires task execution, which is not supported`,
      };
    }
    const started = Date.now();
    try {
      const result = await live.client.request(
        {
          method: "tools/call",
          params: { name: metadata.rawName, arguments: params.arguments },
        },
        CallToolResultSchema,
        { signal },
      );
      if (metadata.outputSchema !== undefined && result.isError !== true) {
        if (result.structuredContent === undefined) {
          throw new Error(
            `desktop MCP tool ${params.serverId}/${params.toolName} declared an output schema but returned no structured content`,
          );
        }
        const validation = outputSchemaValidator.getValidator(
          metadata.outputSchema,
        )(result.structuredContent);
        if (!validation.valid) {
          throw new Error(
            `desktop MCP tool ${params.serverId}/${params.toolName} returned invalid structured content: ${validation.errorMessage}`,
          );
        }
      }
      const redacted = CallToolResultSchema.parse(
        redactValue(result, live.protectedValues),
      );
      console.info("desktop MCP tool call finished", {
        serverId: params.serverId,
        toolName: params.toolName,
        durationMs: Date.now() - started,
        isError: "isError" in result && result.isError === true,
      });
      return convertMcpToolResult(redacted);
    } catch (error) {
      console.error("desktop MCP tool call failed", {
        serverId: params.serverId,
        toolName: params.toolName,
        durationMs: Date.now() - started,
        cancelled: signal.aborted,
      });
      throw new Error(boundedError(error, live.protectedValues));
    }
  };

  return {
    async execute(call, signal) {
      try {
        if (call.tool === "local_mcp_configure") {
          return await configure(call.params, signal);
        }
        if (call.tool === "local_mcp") return await read(call.params, signal);
        return {
          ok: false,
          content: [],
          error: "the desktop MCP host received a non-MCP call",
        };
      } catch (error) {
        return { ok: false, content: [], error: boundedError(error) };
      }
    },
    async close() {
      await serializeConfig(() =>
        Promise.all([...connections.keys()].map(closeServer)),
      );
    },
  };
}

function waitForConnection(
  entry: ConnectionEntry,
  signal: AbortSignal,
): Promise<LiveConnection> {
  if (signal.aborted) {
    if (!entry.settled && entry.waiters === 0) {
      entry.controller.abort(new Error("desktop MCP connection was cancelled"));
    }
    return Promise.reject(abortError(signal));
  }
  entry.waiters += 1;
  return new Promise<LiveConnection>((resolve, reject) => {
    let done = false;
    const settle = (run: () => void): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      entry.waiters -= 1;
      if (!entry.settled && entry.waiters === 0) {
        entry.controller.abort(
          new Error("desktop MCP connection was cancelled"),
        );
      }
      run();
    };
    const onAbort = (): void => settle(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (live) => settle(() => resolve(live)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("desktop MCP operation was cancelled");
}

function searchScore(query: string, tool: CatalogTool): number {
  if (query.length === 0) return 1;
  const name = tool.name.toLowerCase();
  const title = (tool.title ?? tool.annotations?.title ?? "").toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (title.startsWith(query)) return 60;
  if (name.includes(query)) return 40;
  if (title.includes(query)) return 30;
  return description.includes(query) ? 10 : 0;
}

function jsonOutcome(value: Record<string, unknown>): ToolCallOutcome {
  return {
    ok: true,
    content: DeviceContentListSchema.parse([
      { type: "text", text: JSON.stringify(value, null, 2) },
    ]),
    structuredContent: value,
  };
}

function textOutcome(text: string): ToolCallOutcome {
  return { ok: true, content: [{ type: "text", text }] };
}

function missingTool(serverId: string, toolName: string): ToolCallOutcome {
  return {
    ok: false,
    content: [],
    error: `desktop MCP tool ${serverId}/${toolName} is not in the cached catalog`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedError(error: unknown, protectedValues: string[] = []): string {
  return redactText(errorMessage(error), protectedValues).slice(
    0,
    MAX_DEVICE_ERROR_CHARS,
  );
}
