import { posix, win32 } from "node:path";

import { z } from "zod/v4";

const MAX_ID_CHARS = 100;
const MAX_LABEL_CHARS = 200;
const MAX_QUERY_CHARS = 1_000;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_ARGUMENT_BYTES = 1 * 1024 * 1024;
const MAX_CONFIG_ARGS = 100;
const MAX_CONFIG_ARG_CHARS = 4_096;
const MAX_INHERITED_ENV = 100;

function isDesktopAbsolutePath(value: string): boolean {
  return win32.isAbsolute(value) || posix.isAbsolute(value);
}

const IdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_CHARS)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const ToolNameSchema = z.string().min(1).max(MAX_TOOL_NAME_CHARS);
const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_ARGUMENT_BYTES,
    `serialized JSON must not exceed ${MAX_ARGUMENT_BYTES} bytes`,
  );

export const LocalMcpParamsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("servers"),
    desktop: z.string().min(1).optional(),
  }),
  z.object({
    operation: z.literal("search"),
    desktop: z.string().min(1).optional(),
    query: z.string().max(MAX_QUERY_CHARS),
    serverId: IdSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    operation: z.literal("describe"),
    desktop: z.string().min(1).optional(),
    serverId: IdSchema,
    toolName: ToolNameSchema,
  }),
  z.object({
    operation: z.literal("call"),
    desktop: z.string().min(1).optional(),
    serverId: IdSchema,
    toolName: ToolNameSchema,
    arguments: JsonObjectSchema,
  }),
]);
export type LocalMcpParams = z.infer<typeof LocalMcpParamsSchema>;

const DesktopMcpServerConfigSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(MAX_LABEL_CHARS),
  sourceUrl: z.url().max(2_048).optional(),
  enabled: z.boolean(),
  command: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("external"),
      executable: z
        .string()
        .min(1)
        .max(4_096)
        .refine(
          isDesktopAbsolutePath,
          "external executable must be an absolute path",
        ),
    }),
    z.object({ kind: z.literal("bundled"), id: IdSchema }),
  ]),
  args: z.array(z.string().max(MAX_CONFIG_ARG_CHARS)).max(MAX_CONFIG_ARGS),
  cwd: z
    .string()
    .min(1)
    .max(4_096)
    .refine(isDesktopAbsolutePath, "working directory must be an absolute path")
    .optional(),
  inheritEnv: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(MAX_INHERITED_ENV),
});
export type DesktopMcpServerConfig = z.infer<
  typeof DesktopMcpServerConfigSchema
>;

export const LocalMcpConfigureParamsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("upsert"),
    desktop: z.string().min(1).optional(),
    server: DesktopMcpServerConfigSchema,
  }),
  z.object({
    operation: z.literal("remove"),
    desktop: z.string().min(1).optional(),
    serverId: IdSchema,
  }),
  z.object({
    operation: z.literal("set_enabled"),
    desktop: z.string().min(1).optional(),
    serverId: IdSchema,
    enabled: z.boolean(),
  }),
]);
export type LocalMcpConfigureParams = z.infer<
  typeof LocalMcpConfigureParamsSchema
>;
