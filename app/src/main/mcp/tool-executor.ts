import type { McpHost } from "./mcp-host";
import type { DesktopToolExecutor } from "@sandi-server/surfaces/api/client/desktop-client";
import { executeLocalTool } from "@sandi-server/surfaces/api/client/executors";
import type { LocalScriptRuntimeContext } from "@sandi-server/surfaces/api/client/local-script-runtimes";

export function createDesktopToolExecutor(
  host: McpHost,
  localScriptRuntimes?: LocalScriptRuntimeContext,
): DesktopToolExecutor {
  return (call, context, signal) =>
    call.tool === "local_mcp" || call.tool === "local_mcp_configure"
      ? host.execute(call, signal)
      : executeLocalTool(
          call,
          {
            ...context,
            ...(localScriptRuntimes !== undefined
              ? { localScriptRuntimes }
              : {}),
          },
          signal,
        );
}
