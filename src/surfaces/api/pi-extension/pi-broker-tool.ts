import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import {
  type Broker,
  callBroker,
  type ToolCallOutcome,
} from "./tool-broker-client";

export async function callBrokerTool(
  broker: Broker,
  tool: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const outcome = await callBroker(broker, tool, params, signal);
  if (!outcome.ok) {
    const text = outcome.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(outcome.error ?? (text || `${tool} failed`));
  }
  if (
    tool === "local_screenshot" &&
    !outcome.content.some((block) => block.type === "image")
  ) {
    throw new Error(
      "the desktop returned a screenshot result without an image",
    );
  }
  const content: AgentToolResult<Record<string, unknown>>["content"] =
    outcome.content.map((block) =>
      block.type === "text"
        ? block
        : {
            type: "image",
            data: block.dataBase64,
            mimeType: block.mimeType,
          },
    );
  if (content.length === 0) {
    content.push({ type: "text", text: `${tool} ok` });
  }
  return {
    content,
    details: outcomeDetails(tool, outcome),
  };
}

function outcomeDetails(
  tool: string,
  outcome: ToolCallOutcome,
): Record<string, unknown> {
  return {
    tool,
    ok: true,
    desktopMcpIsError: outcome.isError === true,
    hasImage: outcome.content.some((block) => block.type === "image"),
    ...(outcome.structuredContent !== undefined
      ? { structuredContent: outcome.structuredContent }
      : {}),
  };
}

export function toolResultErrorPatch(
  details: unknown,
): { isError: true } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record: Record<string, unknown> = { ...details };
  return record["desktopMcpIsError"] === true ? { isError: true } : undefined;
}
