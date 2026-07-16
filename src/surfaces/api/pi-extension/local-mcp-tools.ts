import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { callBrokerTool, toolResultErrorPatch } from "./pi-broker-tool";
import { readBroker } from "./tool-broker-client";

const desktop = Type.Optional(
  Type.String({
    description: "Desktop id or name from local_list_desktops.",
  }),
);
const serverId = Type.String({ minLength: 1, maxLength: 100 });
const toolName = Type.String({ minLength: 1, maxLength: 200 });

const localMcpParameters = Type.Union([
  Type.Object({ operation: Type.Literal("servers"), desktop }),
  Type.Object({
    operation: Type.Literal("search"),
    desktop,
    query: Type.String({ maxLength: 1_000 }),
    serverId: Type.Optional(serverId),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  }),
  Type.Object({
    operation: Type.Literal("describe"),
    desktop,
    serverId,
    toolName,
  }),
  Type.Object({
    operation: Type.Literal("call"),
    desktop,
    serverId,
    toolName,
    arguments: Type.Record(Type.String(), Type.Unknown()),
  }),
]);

const command = Type.Union([
  Type.Object({
    kind: Type.Literal("external"),
    executable: Type.String({ minLength: 1, maxLength: 4_096 }),
  }),
  Type.Object({
    kind: Type.Literal("bundled"),
    id: Type.String({ minLength: 1, maxLength: 100 }),
  }),
]);

const serverConfig = Type.Object({
  id: serverId,
  label: Type.String({ minLength: 1, maxLength: 200 }),
  sourceUrl: Type.Optional(Type.String({ maxLength: 2_048 })),
  enabled: Type.Boolean(),
  command,
  args: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 100 }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  inheritEnv: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), {
    maxItems: 100,
  }),
});

const localMcpConfigureParameters = Type.Union([
  Type.Object({
    operation: Type.Literal("upsert"),
    desktop,
    server: serverConfig,
  }),
  Type.Object({
    operation: Type.Literal("remove"),
    desktop,
    serverId,
  }),
  Type.Object({
    operation: Type.Literal("set_enabled"),
    desktop,
    serverId,
    enabled: Type.Boolean(),
  }),
]);

export const LOCAL_MCP_TOOL_NAMES = ["local_mcp", "local_mcp_configure"];
export const LOCAL_MCP_CONFIGURE_DESCRIPTION =
  "Add, replace, enable, disable, or remove a desktop MCP server. The desktop app shows the exact persistent change and requires human approval before starting a command or saving it.";

function localMcpTool(broker: NonNullable<ReturnType<typeof readBroker>>) {
  return defineTool({
    name: "local_mcp",
    label: "Use Desktop MCP",
    description:
      "List desktop MCP servers, search their cached tool catalogs, describe an exact tool, or call it on the human's desktop.",
    parameters: localMcpParameters,
    async execute(_id, params, signal) {
      return callBrokerTool(broker, "local_mcp", params, signal);
    },
  });
}

function localMcpConfigureTool(
  broker: NonNullable<ReturnType<typeof readBroker>>,
) {
  return defineTool({
    name: "local_mcp_configure",
    label: "Configure Desktop MCP",
    description: LOCAL_MCP_CONFIGURE_DESCRIPTION,
    parameters: localMcpConfigureParameters,
    async execute(_id, params, signal) {
      return callBrokerTool(broker, "local_mcp_configure", params, signal);
    },
  });
}

export function configuredLocalMcpTools():
  | {
      localMcp: ReturnType<typeof localMcpTool>;
      localMcpConfigure: ReturnType<typeof localMcpConfigureTool>;
    }
  | undefined {
  const broker = readBroker();
  return broker
    ? {
        localMcp: localMcpTool(broker),
        localMcpConfigure: localMcpConfigureTool(broker),
      }
    : undefined;
}

export default function localMcpToolsExtension(pi: ExtensionAPI): void {
  const tools = configuredLocalMcpTools();
  if (!tools) return;
  pi.on("tool_result", (event) => toolResultErrorPatch(event.details));
  pi.registerTool(tools.localMcp);
  pi.registerTool(tools.localMcpConfigure);
}
