import type { McpHost } from "./mcp-host";
import type { DesktopToolExecutor } from "@sandi-server/surfaces/api/client/desktop-client";
import { executeLocalTool } from "@sandi-server/surfaces/api/client/executors";

export function createDesktopToolExecutor(host: McpHost): DesktopToolExecutor {
  return (call, context, signal) =>
    call.tool === "local_mcp" || call.tool === "local_mcp_configure"
      ? host.execute(call, signal)
      : executeLocalTool(call, context, signal);
}
