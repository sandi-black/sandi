import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Wraps a tool's user-facing text and structured details in the shape Pi's agent loop expects. */
export function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
