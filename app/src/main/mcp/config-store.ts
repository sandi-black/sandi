import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isMissingFileError } from "../fs-errors";
import {
  type DesktopMcpServerConfig,
  DesktopMcpServerConfigSchema,
} from "@sandi-server/surfaces/api/devices/mcp-protocol";
import { z } from "zod/v4";

const ConfigFileSchema = z.object({
  version: z.literal(1),
  servers: z.array(DesktopMcpServerConfigSchema).max(100),
});
type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type McpConfigStore = {
  list(): DesktopMcpServerConfig[];
  save(servers: DesktopMcpServerConfig[]): void;
};

export function createMcpConfigStore(filePath: string): McpConfigStore {
  let config = load(filePath);
  return {
    list: () => [...config.servers],
    save(servers) {
      const ids = new Set(servers.map((server) => server.id));
      if (ids.size !== servers.length) {
        throw new Error("desktop MCP server ids must be unique");
      }
      config = ConfigFileSchema.parse({ version: 1, servers });
      save(filePath, config);
    },
  };
}

function load(filePath: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { version: 1, servers: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return quarantine(filePath);
  }
  const parsed = ConfigFileSchema.safeParse(value);
  if (!parsed.success) return quarantine(filePath);
  const ids = new Set(parsed.data.servers.map((server) => server.id));
  return ids.size === parsed.data.servers.length
    ? parsed.data
    : quarantine(filePath);
}

function quarantine(filePath: string): ConfigFile {
  const backup = `${filePath}.corrupt-${randomUUID()}`;
  renameSync(filePath, backup);
  console.error(`desktop MCP config was corrupt; moved it to ${backup}`);
  return { version: 1, servers: [] };
}

function save(filePath: string, config: ConfigFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, filePath);
}
