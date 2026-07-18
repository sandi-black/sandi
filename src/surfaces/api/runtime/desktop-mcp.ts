import {
  type LocalMcpConfigureParams,
  LocalMcpConfigureParamsSchema,
  type LocalMcpParams,
  LocalMcpParamsSchema,
} from "@/surfaces/api/devices/mcp-protocol";
import {
  callBroker,
  readBroker,
  type ToolCallOutcome,
} from "@/surfaces/api/pi-extension/tool-broker-client";

type DesktopSelection = { desktop?: string };
type SearchInput = DesktopSelection & {
  query: string;
  serverId?: string;
  limit?: number;
};
type ExactToolInput = DesktopSelection & {
  serverId: string;
  toolName: string;
};
type CallInput = ExactToolInput & { arguments: Record<string, unknown> };

async function invoke(
  tool: "local_mcp" | "local_mcp_configure",
  params: LocalMcpParams | LocalMcpConfigureParams,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const broker = readBroker();
  if (!broker) {
    throw new Error("desktop MCP is unavailable for this turn");
  }
  const outcome = await callBroker(broker, tool, params, signal);
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "desktop MCP operation failed");
  }
  return outcome;
}

export const desktopMcp = {
  servers(
    input: DesktopSelection = {},
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const params = LocalMcpParamsSchema.parse({
      operation: "servers",
      ...input,
    });
    return invoke("local_mcp", params, signal);
  },

  search(input: SearchInput, signal?: AbortSignal): Promise<ToolCallOutcome> {
    const params = LocalMcpParamsSchema.parse({
      operation: "search",
      ...input,
    });
    return invoke("local_mcp", params, signal);
  },

  describe(
    input: ExactToolInput,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const params = LocalMcpParamsSchema.parse({
      operation: "describe",
      ...input,
    });
    return invoke("local_mcp", params, signal);
  },

  disconnect(
    input: DesktopSelection & { serverId: string },
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const params = LocalMcpParamsSchema.parse({
      operation: "disconnect",
      ...input,
    });
    return invoke("local_mcp", params, signal);
  },

  call(input: CallInput, signal?: AbortSignal): Promise<ToolCallOutcome> {
    const params = LocalMcpParamsSchema.parse({
      operation: "call",
      ...input,
    });
    return invoke("local_mcp", params, signal);
  },

  configure(
    input: LocalMcpConfigureParams,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const params = LocalMcpConfigureParamsSchema.parse(input);
    return invoke("local_mcp_configure", params, signal);
  },
};
