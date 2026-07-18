import { assert, assertEqual } from "@/lib/verification/harness";
import {
  LocalMcpConfigureParamsSchema,
  LocalMcpParamsSchema,
} from "@/surfaces/api/devices/mcp-protocol";
import {
  BrokerCallSchema,
  DeviceResultSchema,
  MAX_DEVICE_CONTENT_BLOCKS,
  MAX_DEVICE_ERROR_CHARS,
  MAX_DEVICE_IMAGE_BASE64_CHARS,
  MAX_DEVICE_TEXT_CHARS,
  MAX_LOCAL_SCRIPT_SOURCE_CHARS,
} from "@/surfaces/api/devices/protocol";

function verifyDeviceProtocol(): void {
  const webp = makeWebp(32);
  const complete = DeviceResultSchema.safeParse({
    id: "grace-result",
    ok: true,
    content: [
      { type: "text", text: "first" },
      { type: "image", mimeType: "image/webp", dataBase64: webp },
      { type: "text", text: "last" },
    ],
    isError: true,
    structuredContent: { rows: [{ name: "Ada" }] },
  });
  assert(complete.success, "a complete multi-block MCP result is accepted");
  if (complete.success) {
    assertEqual(
      complete.data.content.length,
      3,
      "content block order is preserved",
    );
    assertEqual(
      complete.data.isError,
      true,
      "an MCP tool-level error remains distinct from transport success",
    );
  }

  assert(
    !DeviceResultSchema.safeParse({
      id: "bad-webp",
      ok: true,
      content: [
        { type: "image", mimeType: "image/webp", dataBase64: "/9j/4AAQ" },
      ],
    }).success,
    "image bytes must match their declared WebP type",
  );
  assert(
    !DeviceResultSchema.safeParse({
      id: "too-many",
      ok: true,
      content: Array.from({ length: MAX_DEVICE_CONTENT_BLOCKS + 1 }, () => ({
        type: "text",
        text: "x",
      })),
    }).success,
    "content block count is bounded",
  );
  assert(
    !DeviceResultSchema.safeParse({
      id: "too-much-text",
      ok: true,
      content: [{ type: "text", text: "x".repeat(MAX_DEVICE_TEXT_CHARS + 1) }],
    }).success,
    "aggregate text is bounded",
  );
  const oversizedWebp = makeWebp(
    Math.floor((MAX_DEVICE_IMAGE_BASE64_CHARS * 3) / 4) + 16,
  );
  assert(
    oversizedWebp.length > MAX_DEVICE_IMAGE_BASE64_CHARS &&
      !DeviceResultSchema.safeParse({
        id: "too-much-image",
        ok: true,
        content: [
          {
            type: "image",
            mimeType: "image/webp",
            dataBase64: oversizedWebp,
          },
        ],
      }).success,
    "aggregate image data is bounded",
  );
  assert(
    !DeviceResultSchema.safeParse({
      id: "bad-structure",
      ok: true,
      content: [],
      structuredContent: [],
    }).success,
    "structured content must be a JSON object",
  );
  assert(
    !DeviceResultSchema.safeParse({
      id: "too-much-error",
      ok: false,
      content: [],
      error: "x".repeat(MAX_DEVICE_ERROR_CHARS + 1),
    }).success,
    "broker error text is bounded",
  );

  const call = BrokerCallSchema.safeParse({
    tool: "local_mcp",
    params: {
      operation: "call",
      desktop: "Ada's workstation",
      serverId: "grace-fixture",
      toolName: "Snapshot",
      arguments: { window: "Calculator" },
    },
  });
  assert(call.success, "the broker accepts a bounded exact MCP tool call");
  assert(
    BrokerCallSchema.safeParse({
      tool: "local_js_run",
      params: { desktop: "Ada's workstation", code: "console.log(42)" },
    }).success,
    "the broker accepts desktop-routed inline JavaScript",
  );
  assert(
    BrokerCallSchema.safeParse({
      tool: "local_autoit_run",
      params: { code: 'ConsoleWrite("Ada")', timeoutMs: 1_000 },
    }).success,
    "the broker accepts bounded inline AutoIt",
  );
  assert(
    BrokerCallSchema.safeParse({
      tool: "local_desktop_activity",
      params: { desktop: "Ada's workstation" },
    }).success,
    "the broker accepts a routed desktop activity observation",
  );
  assert(
    !BrokerCallSchema.safeParse({
      tool: "local_autoit_run",
      params: { code: "x".repeat(MAX_LOCAL_SCRIPT_SOURCE_CHARS + 1) },
    }).success,
    "the broker rejects oversized inline scripts",
  );
  assert(
    !BrokerCallSchema.safeParse({
      tool: "local_js_run",
      params: { code: "console.log(42)", timeoutMs: 600_001 },
    }).success,
    "the broker rejects an out-of-range script timeout",
  );
  assert(
    LocalMcpParamsSchema.safeParse({
      operation: "search",
      query: "",
      limit: 20,
    }).success,
    "an empty MCP search query can list bounded matches",
  );
  assert(
    LocalMcpParamsSchema.safeParse({
      operation: "disconnect",
      serverId: "chrome-devtools",
    }).success,
    "MCP disconnect addresses a configured server without changing it",
  );
  assert(
    !LocalMcpParamsSchema.safeParse({
      operation: "call",
      serverId: "grace-fixture",
      toolName: "Snapshot",
      arguments: { input: "x".repeat(1_048_576) },
    }).success,
    "MCP call arguments are bounded by serialized size",
  );
  assert(
    LocalMcpConfigureParamsSchema.safeParse({
      operation: "upsert",
      server: {
        id: "chrome-devtools",
        label: "Chrome DevTools",
        enabled: true,
        command: {
          kind: "external",
          executable: "C:\\Program Files\\Sandi\\mcp-server.exe",
        },
        args: [],
        inheritEnv: ["CHROME_PROFILE"],
      },
    }).success,
    "MCP configuration carries environment names without their values",
  );
  assert(
    LocalMcpConfigureParamsSchema.safeParse({
      operation: "upsert",
      server: {
        id: "linux-tool",
        label: "Linux tool",
        enabled: true,
        command: { kind: "external", executable: "/opt/sandi/mcp-server" },
        args: [],
        cwd: "/opt/sandi",
        inheritEnv: [],
      },
    }).success,
    "desktop paths are validated independently of the broker host OS",
  );
  assert(
    !LocalMcpConfigureParamsSchema.safeParse({
      operation: "upsert",
      server: {
        id: "bad-command",
        label: "Bad command",
        enabled: true,
        command: { kind: "external", executable: "mcp-server" },
        args: [],
        inheritEnv: [],
      },
    }).success,
    "external MCP commands must use absolute executable paths",
  );

  console.log("device MCP protocol verification passed");
}

function makeWebp(byteLength: number): string {
  const bytes = Buffer.alloc(Math.max(12, byteLength));
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  return bytes.toString("base64");
}

verifyDeviceProtocol();
