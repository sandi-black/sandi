import type { BrowserWindow } from "electron";
import { dialog } from "electron";

import type { McpConfigChange } from "./mcp-host";

export async function approveMcpChange(
  change: McpConfigChange,
  parent?: BrowserWindow,
): Promise<boolean> {
  const options = {
    type: "warning" as const,
    title: "Approve desktop MCP change",
    message: summary(change),
    detail: JSON.stringify(change, null, 2),
    buttons: ["Deny", "Approve"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

function summary(change: McpConfigChange): string {
  switch (change.operation) {
    case "upsert":
      return `Allow Sandi to save MCP server "${change.server.label}" (${change.server.id})?`;
    case "remove":
      return `Allow Sandi to remove MCP server ${change.serverId}?`;
    case "set_enabled":
      return `Allow Sandi to ${change.enabled ? "enable" : "disable"} MCP server ${change.serverId}?`;
  }
}
