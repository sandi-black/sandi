import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DeviceContentListSchema,
  type ToolCallOutcome,
  ToolCallOutcomeSchema,
} from "@sandi-server/surfaces/api/devices/protocol";

type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

export function convertMcpToolResult(result: McpCallResult): ToolCallOutcome {
  const parsed = CallToolResultSchema.safeParse(result);
  if (!parsed.success) {
    return {
      ok: true,
      content: [
        { type: "text", text: "MCP returned a task result without content." },
      ],
    };
  }
  const candidate = parsed.data.content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        if (
          block.mimeType === "image/jpeg" ||
          block.mimeType === "image/png" ||
          block.mimeType === "image/webp"
        ) {
          return {
            type: "image",
            mimeType: block.mimeType,
            dataBase64: block.data,
          };
        }
        return {
          type: "text",
          text: `[omitted unsupported MCP image ${block.mimeType}]`,
        };
      case "audio":
        return {
          type: "text",
          text: `[omitted unsupported MCP audio ${block.mimeType}]`,
        };
      case "resource_link":
        return {
          type: "text",
          text: `[MCP resource link: ${block.name} (${block.uri})]`,
        };
      case "resource":
        return "text" in block.resource
          ? {
              type: "text",
              text: `[MCP resource ${block.resource.uri}]\n${block.resource.text}`,
            }
          : {
              type: "text",
              text: `[omitted binary MCP resource ${block.resource.uri}]`,
            };
    }
    return { type: "text", text: "[omitted unsupported MCP content]" };
  });
  const content = DeviceContentListSchema.parse(candidate);
  const outcome: ToolCallOutcome = {
    ok: true,
    content,
    ...(parsed.data.isError !== undefined
      ? { isError: parsed.data.isError }
      : {}),
    ...(parsed.data.structuredContent !== undefined
      ? { structuredContent: parsed.data.structuredContent }
      : {}),
  };
  const bounded = ToolCallOutcomeSchema.safeParse(outcome);
  return bounded.success
    ? bounded.data
    : {
        ok: false,
        content: [],
        error: "MCP tool result exceeded desktop result limits",
      };
}
