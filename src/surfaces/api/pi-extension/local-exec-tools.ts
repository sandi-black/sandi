import { request as httpRequest } from "node:http";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// Proxy tools for hands-local api turns. pi runs server-side with its built-in
// file and shell tools disabled (--no-builtin-tools); these take their place and
// route every call to the caller's desktop over a per-turn loopback broker. The
// desktop executes locally and returns the evidence.
//
// This file is loaded directly by the pi CLI, which does not honor the tsconfig
// path alias, so it imports nothing from `@/` and re-states the broker env-var
// names and wire shapes that src/surfaces/api/devices/protocol.ts owns. The two
// are the ends of one JSON contract.

const TOOL_BROKER_URL_ENV = "SANDI_TOOL_BROKER_URL";
const TOOL_BROKER_TOKEN_ENV = "SANDI_TOOL_BROKER_TOKEN";

// A loopback call may carry a long shell command; stay just past the broker's
// own backstop so the broker, not the socket, decides a stalled call's fate.
const CALL_TIMEOUT_MS = 11 * 60_000;
const DESKTOP_HINT =
  "Operates on the human's local desktop, not the server. Paths are resolved on that machine.";

export default function localExecToolsExtension(pi: ExtensionAPI): void {
  const broker = readBroker();
  if (!broker) {
    // No desktop is paired to this turn (or this is not a hands-local surface).
    // Register nothing: the turn runs without file or shell tools rather than
    // silently falling back to executing on the server.
    return;
  }

  pi.registerTool(
    defineTool({
      name: "local_read",
      label: "Read Local File",
      description: `Read a file from the human's desktop. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        path: Type.String({
          description: "Absolute or desktop-relative path.",
        }),
        offset: Type.Optional(
          Type.Number({ description: "First line to read (0-based)." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of lines to read." }),
        ),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_read", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_write",
      label: "Write Local File",
      description: `Create or overwrite a file on the human's desktop. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        path: Type.String({ description: "Path to write." }),
        content: Type.String({ description: "Full file contents to write." }),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_write", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_edit",
      label: "Edit Local File",
      description: `Replace an exact substring in a file on the human's desktop. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        path: Type.String({ description: "Path to edit." }),
        oldString: Type.String({ description: "Exact text to replace." }),
        newString: Type.String({ description: "Replacement text." }),
        replaceAll: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence." }),
        ),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_edit", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_ls",
      label: "List Local Directory",
      description: `List the entries of a directory on the human's desktop. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        path: Type.String({ description: "Directory to list." }),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_ls", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_glob",
      label: "Find Local Files",
      description: `Find files on the human's desktop by glob pattern (supports ** and *). ${DESKTOP_HINT}`,
      parameters: Type.Object({
        pattern: Type.String({
          description: "Glob pattern, e.g. src/**/*.ts.",
        }),
        path: Type.Optional(
          Type.String({ description: "Directory to search from." }),
        ),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_glob", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_grep",
      label: "Search Local Files",
      description: `Search file contents on the human's desktop with a regular expression. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        pattern: Type.String({
          description: "Regular expression to search for.",
        }),
        path: Type.Optional(
          Type.String({ description: "File or directory to search." }),
        ),
        glob: Type.Optional(
          Type.String({ description: "Only search files matching this glob." }),
        ),
        ignoreCase: Type.Optional(
          Type.Boolean({ description: "Case-insensitive search." }),
        ),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_grep", params);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "local_bash",
      label: "Run Local Shell Command",
      description: `Run a shell command on the human's desktop and return its output. ${DESKTOP_HINT}`,
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run." }),
        cwd: Type.Optional(
          Type.String({ description: "Working directory for the command." }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds." }),
        ),
      }),
      async execute(_id, params) {
        return callTool(broker, "local_bash", params);
      },
    }),
  );
}

export type Broker = {
  url: string;
  token: string;
};

// Exported for tests: reads and validates the per-turn broker coordinates the
// api surface set on the pi child, or undefined when none was leased or the
// values are malformed. Validating the URL and token shape at this env boundary
// means a bad value disables the tools up front rather than failing later inside
// a tool call's post().
export function readBroker(): Broker | undefined {
  const rawUrl = process.env[TOOL_BROKER_URL_ENV]?.trim();
  const rawToken = process.env[TOOL_BROKER_TOKEN_ENV]?.trim();
  if (!rawUrl || !rawToken) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  // The broker listens on a loopback http origin that the api surface set on
  // this child. Pin it to http on 127.0.0.1: a non-loopback or non-http value
  // would mean the env was tampered with, and a tool call must never leave the
  // local hop.
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.hostname !== "127.0.0.1") return undefined;
  // The broker mints a hex secret (32 bytes -> exactly 64 hex chars). Require
  // that exact shape so a truncated or non-hex token is rejected here, not as a
  // late broker 401.
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return undefined;
  return { url: parsed.origin, token: rawToken };
}

type ToolCallOutcome = {
  ok: boolean;
  output: string;
  error?: string;
};

// Exported for tests: POSTs one tool call to the broker and maps the outcome to
// a pi tool result, throwing so pi surfaces a tool error when the desktop
// refuses the call or is unavailable.
export async function callTool(
  broker: Broker,
  tool: string,
  params: unknown,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const outcome = await post(broker, { tool, params });
  if (!outcome.ok) {
    // The desktop refused or could not attempt the call. Throw so pi surfaces a
    // tool error to the model instead of presenting a failure as evidence.
    throw new Error(outcome.error ?? (outcome.output || `${tool} failed`));
  }
  return {
    content: [{ type: "text", text: outcome.output }],
    details: { tool, ok: true },
  };
}

function post(
  broker: Broker,
  body: { tool: string; params: unknown },
): Promise<ToolCallOutcome> {
  return new Promise((resolvePost, rejectPost) => {
    let target: URL;
    try {
      target = new URL("/call", broker.url);
    } catch (error) {
      rejectPost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": payload.length,
          authorization: `Bearer ${broker.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (status === 503) {
            rejectPost(
              new Error(
                "the desktop is not connected; local file and shell tools are unavailable",
              ),
            );
            return;
          }
          if (status !== 200) {
            rejectPost(
              new Error(`tool broker returned status ${status}: ${raw}`),
            );
            return;
          }
          try {
            resolvePost(parseOutcome(raw));
          } catch (error) {
            rejectPost(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        });
      },
    );
    req.setTimeout(CALL_TIMEOUT_MS, () => {
      req.destroy(new Error("local tool call timed out"));
    });
    req.on("error", (error) => rejectPost(error));
    req.end(payload);
  });
}

function parseOutcome(raw: string): ToolCallOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tool broker returned a non-object result");
  }
  const record: Record<string, unknown> = { ...parsed };
  const ok = record["ok"];
  const output = record["output"];
  if (typeof ok !== "boolean" || typeof output !== "string") {
    throw new Error("tool broker result was malformed");
  }
  const error = record["error"];
  return {
    ok,
    output,
    ...(typeof error === "string" ? { error } : {}),
  };
}
