import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";

import { z } from "zod/v4";

type AskSandi = (input: {
  message: string;
  conversation: string;
  signal: AbortSignal;
}) => Promise<string>;

// Protocol revision 2026-07-28 has no sessions, so the endpoint builds one of
// these per request. Conversation continuity rides in the tool arguments
// instead, as the spec recommends: the first call mints a handle and the agent
// passes it back to keep talking in the same Sandi conversation.
export function createAskSandiServer(ask: AskSandi): McpServer {
  const server = new McpServer({ name: "sandi", version: "0.1.0" });
  server.registerTool(
    "ask_sandi",
    {
      title: "Ask Sandi",
      description:
        "Send a message to Sandi, a household agent with her own memory, skills, and per-person context, and return her reply. Relay her reply to the user without rewriting it. Omit `conversation` to start a new conversation, or pass the `conversation` value from an earlier result to continue it.",
      inputSchema: z.object({
        message: z
          .string()
          .min(1)
          .describe("The user's message to Sandi, in their words."),
        conversation: z
          .string()
          .optional()
          .describe(
            "Conversation handle from an earlier ask_sandi result: letters, digits, '.', '_', or '-', at most 200 characters.",
          ),
      }),
      outputSchema: z.object({
        conversation: z.string(),
        reply: z.string(),
      }),
    },
    async ({ message, conversation }, ctx) => {
      const handle = conversation ?? `mcp-${randomUUID()}`;
      const reply = await ask({
        message,
        conversation: handle,
        signal: ctx.mcpReq.signal,
      });
      const output = { conversation: handle, reply };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}
