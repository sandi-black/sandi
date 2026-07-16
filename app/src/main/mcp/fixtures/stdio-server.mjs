import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const statePath = process.env["SANDI_MCP_FIXTURE_STATE"];
const record = (event) => {
  if (statePath) appendFileSync(statePath, `${event}\n`, "utf8");
};

const server = new Server(
  { name: "sandi-mcp-fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);
let hasExtraTool = false;
let slowNextList = false;

const tools = () => [
  {
    name: "echo",
    title: "Echo fixture",
    description: `Returns ordered text, image, and structured content. ${process.env["SANDI_MCP_FIXTURE_SECRET"] ?? ""}`,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    outputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        secretPresent: { type: "boolean" },
        secretEcho: {
          type: "string",
          const: process.env["SANDI_MCP_FIXTURE_SECRET"] ?? "",
        },
        pathPresent: { type: "boolean" },
        pathValue: { type: "string" },
        userProfilePresent: { type: "boolean" },
        unapprovedPresent: { type: "boolean" },
        processArgs: { type: "array", items: { type: "string" } },
      },
      required: [
        "message",
        "secretPresent",
        "secretEcho",
        "pathPresent",
        "pathValue",
        "userProfilePresent",
        "unapprovedPresent",
        "processArgs",
      ],
    },
  },
  {
    name: "invalid_output",
    description: "Returns structured content that violates its schema.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    },
  },
  {
    name: "add_tool",
    description: "Adds a tool and sends tools/list_changed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description: "Waits until cancelled.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crash",
    description: "Closes the fixture transport.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "secret_error",
    description: "Throws an error containing an inherited value.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fail_catalog_with_secret",
    description: "Makes later catalog refreshes expose an inherited value.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "malformed_frame",
    description: "Writes malformed JSON to stdout.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "oversized_structured",
    description: "Returns structured content beyond the device limit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notify_storm",
    description: "Sends many catalog change notifications.",
    inputSchema: { type: "object", properties: {} },
  },
  ...(hasExtraTool
    ? [
        {
          name: "extra",
          description: "Added after a list-changed notification.",
          inputSchema: { type: "object", properties: {} },
        },
      ]
    : []),
];

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const failureMarker = process.env["SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER"];
  if (failureMarker && existsSync(failureMarker)) {
    const attempt = Number.parseInt(readFileSync(failureMarker, "utf8"), 10);
    writeFileSync(failureMarker, String(attempt + 1), "utf8");
    // Fail the existing client's refresh, allow the reconnect's initialization
    // refresh, then fail prepareCall's immediate post-reconnect refresh. This
    // reaches the distinct error boundary that must redact with the new client.
    if (attempt !== 1) {
      throw new Error(process.env["SANDI_MCP_FIXTURE_SECRET"] ?? "missing");
    }
  }
  record("list");
  const listDelay = Number(process.env["SANDI_MCP_FIXTURE_LIST_DELAY_MS"] ?? 0);
  if (Number.isFinite(listDelay) && listDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, listDelay));
  }
  if (slowNextList) {
    slowNextList = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const all = tools();
  const cursor = request.params?.cursor;
  if (cursor === undefined) record("list-start");
  if (process.env["SANDI_MCP_FIXTURE_UNBOUNDED_PAGES"] === "1") {
    const page = cursor?.startsWith("unique-")
      ? Number.parseInt(cursor.slice(7), 10)
      : 0;
    return { tools: [], nextCursor: `unique-${page + 1}` };
  }
  if (process.env["SANDI_MCP_FIXTURE_REPEAT_CURSOR"] === "1") {
    return { tools: all.slice(0, 1), nextCursor: "same" };
  }
  const offset = cursor?.startsWith("page-")
    ? Number.parseInt(cursor.slice(5), 10)
    : 0;
  return {
    tools: all.slice(offset, offset + 2),
    ...(offset + 2 < all.length ? { nextCursor: `page-${offset + 2}` } : {}),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  record(`call:${name}`);
  if (name === "echo") {
    const message = request.params.arguments?.["message"];
    const secret = process.env["SANDI_MCP_FIXTURE_SECRET"] ?? "";
    return {
      content: [
        { type: "text", text: `first:${String(message)}:${secret}` },
        {
          type: "image",
          mimeType: "image/webp",
          data: "UklGRgQAAABXRUJQ",
        },
        { type: "text", text: "last" },
      ],
      structuredContent: {
        message,
        secretPresent: secret.length > 0,
        secretEcho: secret,
        pathPresent: process.env["PATH"] !== undefined,
        pathValue: process.env["PATH"] ?? "",
        userProfilePresent: process.env["USERPROFILE"] !== undefined,
        unapprovedPresent:
          process.env["SANDI_MCP_FIXTURE_UNAPPROVED"] !== undefined,
        processArgs: process.argv.slice(2),
      },
    };
  }
  if (name === "invalid_output") {
    return {
      content: [{ type: "text", text: "invalid" }],
      structuredContent: { count: "wrong" },
    };
  }
  if (name === "add_tool") {
    hasExtraTool = true;
    await server.notification({ method: "notifications/tools/list_changed" });
    return { content: [{ type: "text", text: "added" }] };
  }
  if (name === "wait") {
    await new Promise((resolve) => {
      if (extra.signal.aborted) {
        resolve(undefined);
        return;
      }
      extra.signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
    });
    record("cancelled:wait");
    return {
      content: [{ type: "text", text: "cancelled" }],
      isError: true,
    };
  }
  if (name === "crash") {
    setTimeout(() => process.exit(23), 0);
    return { content: [{ type: "text", text: "crashing" }] };
  }
  if (name === "secret_error") {
    throw new Error(process.env["SANDI_MCP_FIXTURE_SECRET"] ?? "missing");
  }
  if (name === "fail_catalog_with_secret") {
    const failureMarker = process.env["SANDI_MCP_FIXTURE_REFRESH_FAILURE_MARKER"];
    if (failureMarker) writeFileSync(failureMarker, "0", "utf8");
    return { content: [{ type: "text", text: "armed" }] };
  }
  if (name === "malformed_frame") {
    process.stdout.write("{malformed MCP frame}\n");
    await new Promise(() => undefined);
  }
  if (name === "oversized_structured") {
    return {
      content: [{ type: "text", text: "too large" }],
      structuredContent: { payload: "x".repeat(1_100_000) },
    };
  }
  if (name === "notify_storm") {
    slowNextList = true;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        server.notification({ method: "notifications/tools/list_changed" }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        server.notification({ method: "notifications/tools/list_changed" }),
      ),
    );
    return { content: [{ type: "text", text: "notified" }] };
  }
  return { content: [{ type: "text", text: `called:${name}` }] };
});

record("start");
process.on("exit", () => record("exit"));
await server.connect(new StdioServerTransport());
