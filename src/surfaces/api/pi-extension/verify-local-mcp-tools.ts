import { assert, assertEqual } from "../../../lib/verification/harness";
import localMcpToolsExtension, {
  configuredLocalMcpTools,
  LOCAL_MCP_CONFIGURE_DESCRIPTION,
  LOCAL_MCP_TOOL_NAMES,
} from "./local-mcp-tools";

const urlBefore = process.env["SANDI_TOOL_BROKER_URL"];
const tokenBefore = process.env["SANDI_TOOL_BROKER_TOKEN"];
try {
  delete process.env["SANDI_TOOL_BROKER_URL"];
  delete process.env["SANDI_TOOL_BROKER_TOKEN"];
  assertEqual(
    configuredLocalMcpTools(),
    undefined,
    "a turn without a desktop broker registers no MCP tools",
  );

  process.env["SANDI_TOOL_BROKER_URL"] = "https://example.com";
  process.env["SANDI_TOOL_BROKER_TOKEN"] = "a".repeat(64);
  assertEqual(
    configuredLocalMcpTools(),
    undefined,
    "malformed broker coordinates register no MCP tools",
  );

  process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
  const tools = configuredLocalMcpTools();
  assert(tools !== undefined, "valid turn broker coordinates create MCP tools");
  assertEqual(
    [tools.localMcp.name, tools.localMcpConfigure.name].join(","),
    LOCAL_MCP_TOOL_NAMES.join(","),
    "a valid broker registers exactly the fixed two-tool surface",
  );
  assertEqual(
    tools.localMcpConfigure.description,
    LOCAL_MCP_CONFIGURE_DESCRIPTION,
    "the registered configuration tool uses the desktop lease contract",
  );
  assert(
    LOCAL_MCP_CONFIGURE_DESCRIPTION.includes("authenticated desktop lease"),
    "the configuration tool tells Pi where persistent changes execute",
  );
  assert(
    tools.localMcp.description.includes("disconnect"),
    "the MCP tool advertises explicit connection release",
  );
  assert(
    JSON.stringify(tools.localMcp.parameters).includes('"disconnect"'),
    "the MCP tool schema exposes explicit disconnect",
  );

  const registered: string[] = [];
  let errorHook: unknown;
  const fakeApi = {
    on(event: unknown, handler: unknown): void {
      if (event === "tool_result") errorHook = handler;
    },
    registerTool(tool: unknown): void {
      if (typeof tool === "object" && tool !== null) {
        registered.push(String(Reflect.get(tool, "name")));
      }
    },
  };
  Reflect.apply(localMcpToolsExtension, undefined, [fakeApi]);
  assertEqual(
    registered.join(","),
    LOCAL_MCP_TOOL_NAMES.join(","),
    "the extension registers exactly both configured MCP tools",
  );
  assert(
    typeof errorHook === "function",
    "the extension installs its error hook",
  );
  const patched = Reflect.apply(errorHook, undefined, [
    { details: { isError: true } },
  ]);
  assert(
    typeof patched === "object" &&
      patched !== null &&
      Reflect.get(patched, "isError") === true,
    "the registered hook maps MCP errors into Pi's error channel",
  );
} finally {
  restoreEnv("SANDI_TOOL_BROKER_URL", urlBefore);
  restoreEnv("SANDI_TOOL_BROKER_TOKEN", tokenBefore);
}

console.log("local MCP tools verification passed");

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
