import { createServer, type Server } from "node:http";

import { assert, assertEqual } from "@/lib/verification/harness";
import { desktopMcp } from "@/surfaces/api/runtime/desktop-mcp";

const urlBefore = process.env["SANDI_TOOL_BROKER_URL"];
const tokenBefore = process.env["SANDI_TOOL_BROKER_TOKEN"];

try {
  delete process.env["SANDI_TOOL_BROKER_URL"];
  delete process.env["SANDI_TOOL_BROKER_TOKEN"];
  await expectUnavailable();

  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof body !== "object" || body === null) {
        response.writeHead(400).end();
        return;
      }
      const tool = Reflect.get(body, "tool");
      const params = Reflect.get(body, "params");
      if (
        typeof tool !== "string" ||
        typeof params !== "object" ||
        params === null
      ) {
        response.writeHead(400).end();
        return;
      }
      calls.push({ tool, params: { ...params } });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          content: [{ type: "text", text: `call ${calls.length}` }],
          structuredContent: { sequence: calls.length },
        }),
      );
    });
  });
  await listen(server);
  try {
    const address = server.address();
    assert(
      address !== null && typeof address === "object",
      "broker has a TCP address",
    );
    process.env["SANDI_TOOL_BROKER_URL"] = `http://127.0.0.1:${address.port}`;
    process.env["SANDI_TOOL_BROKER_TOKEN"] = "a".repeat(64);

    const search = await desktopMcp.search({ query: "window" });
    const first = await desktopMcp.call({
      serverId: "grace",
      toolName: "inspect",
      arguments: {},
    });
    const second = await desktopMcp.call({
      serverId: "grace",
      toolName: "click",
      arguments: { target: "Save" },
    });
    await desktopMcp.disconnect({ serverId: "grace" });

    assertEqual(calls.length, 4, "one runtime can make dependent broker calls");
    assertEqual(calls[0]?.params["operation"], "search", "search is routed");
    assertEqual(
      calls[1]?.params["toolName"],
      "inspect",
      "first call is routed",
    );
    assertEqual(calls[2]?.params["toolName"], "click", "second call is routed");
    assertEqual(
      calls[3]?.params["operation"],
      "disconnect",
      "explicit disconnect is routed",
    );
    assertEqual(
      search.structuredContent?.["sequence"],
      1,
      "structured search content is preserved",
    );
    assertEqual(
      first.content[0]?.type,
      "text",
      "native content blocks are preserved",
    );
    assertEqual(
      second.structuredContent?.["sequence"],
      3,
      "the same inherited broker ticket remains usable",
    );
  } finally {
    await close(server);
  }
  console.log("desktop MCP runtime verification passed");
} finally {
  restoreEnv("SANDI_TOOL_BROKER_URL", urlBefore);
  restoreEnv("SANDI_TOOL_BROKER_TOKEN", tokenBefore);
}

async function expectUnavailable(): Promise<void> {
  try {
    await desktopMcp.servers();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("unavailable"),
      "an absent turn broker produces a clear error",
    );
    return;
  }
  throw new Error("desktop MCP unexpectedly ran without a turn broker");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
