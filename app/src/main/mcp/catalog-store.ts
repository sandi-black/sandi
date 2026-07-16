import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isMissingFileError } from "../fs-errors";
import { z } from "zod/v4";

const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024,
    "tool schema exceeds 64 KiB",
  );
const CatalogToolSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  description: z.string().max(2_000).optional(),
  inputSchema: JsonObjectSchema,
  outputSchema: JsonObjectSchema.optional(),
  execution: z
    .object({
      taskSupport: z.enum(["optional", "required", "forbidden"]).optional(),
    })
    .optional(),
  annotations: z
    .object({
      title: z.string().max(500).optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});
export type CatalogTool = z.infer<typeof CatalogToolSchema>;
export const MAX_MCP_CATALOG_BYTES = 4 * 1024 * 1024;
const CatalogSchema = z
  .object({
    version: z.literal(1),
    serverId: z.string().min(1).max(100),
    updatedAt: z.string(),
    tools: z.array(CatalogToolSchema).max(500),
  })
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_MCP_CATALOG_BYTES,
    "catalog snapshot exceeds 4 MiB",
  );
export type McpCatalog = z.infer<typeof CatalogSchema>;

export type McpCatalogStore = {
  load(serverId: string): McpCatalog | undefined;
  save(serverId: string, tools: CatalogTool[]): McpCatalog;
  remove(serverId: string): void;
};

export function createMcpCatalogStore(directory: string): McpCatalogStore {
  return {
    load(serverId) {
      const path = catalogPath(directory, serverId);
      let raw: string;
      try {
        if (statSync(path).size > 8 * 1024 * 1024) {
          quarantine(path);
          return undefined;
        }
        raw = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        quarantine(path);
        return undefined;
      }
      const parsed = CatalogSchema.safeParse(value);
      if (!parsed.success || parsed.data.serverId !== serverId) {
        quarantine(path);
        return undefined;
      }
      return parsed.data;
    },
    save(serverId, tools) {
      const catalog = CatalogSchema.parse({
        version: 1,
        serverId,
        updatedAt: new Date().toISOString(),
        tools,
      });
      mkdirSync(directory, { recursive: true });
      const path = catalogPath(directory, serverId);
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      renameSync(temp, path);
      return catalog;
    },
    remove(serverId) {
      const path = catalogPath(directory, serverId);
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    },
  };
}

export function parseCatalogTool(value: unknown): CatalogTool {
  return CatalogToolSchema.parse(value);
}

export function catalogToolBytes(tool: CatalogTool): number {
  return Buffer.byteLength(JSON.stringify(tool), "utf8");
}

function catalogPath(directory: string, serverId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(serverId)) {
    throw new Error("invalid desktop MCP server id");
  }
  return join(directory, `${serverId}.json`);
}

function quarantine(path: string): void {
  const backup = `${path}.corrupt-${randomUUID()}`;
  renameSync(path, backup);
  console.error(`desktop MCP catalog was corrupt; moved it to ${backup}`);
}
