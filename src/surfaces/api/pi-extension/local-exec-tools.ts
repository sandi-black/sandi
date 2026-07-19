import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { callBrokerTool } from "./pi-broker-tool";
import { readBroker } from "./tool-broker-client";

// Proxy tools for hands-local api turns. pi runs server-side with its built-in
// file and shell tools disabled (--no-builtin-tools); these take their place and
// route every call to the caller's desktop over a per-turn loopback broker. The
// desktop executes locally and returns the evidence.
//
// This file is loaded directly by the pi CLI, which does not honor the tsconfig
// path alias, so it imports nothing from `@/` and re-states the broker env-var
// names and wire shapes that src/surfaces/api/devices/protocol.ts owns. The two
// are the ends of one JSON contract.

// This extension is loaded outside the app module graph, so mirror the wire
// schema's limit here and verify it through the extension registration checks.
const MAX_LOCAL_GREP_PATTERN_CHARS = 16_384;
const MAX_LOCAL_SCRIPT_SOURCE_CHARS = 80_000;

const DESKTOP_HINT =
  "Operates on the human's local desktop, not the server. Paths are resolved on that machine.";
// Every tool may run on any desktop the human has connected. The selector names
// one from local_list_desktops;
// omitting it uses the originating desktop, or, when the turn did not originate
// on a desktop and several are connected, the call asks you to name one.
const DESKTOP_SELECTOR_HINT =
  "Optional desktop to run on (an id or name from local_list_desktops). Omit to use the current desktop.";

// The selector parameter, shared by every proxy tool so the model can redirect
// any call to another of the caller's connected desktops.
const desktopParam = Type.Optional(
  Type.String({ description: DESKTOP_SELECTOR_HINT }),
);

const nativeWindowIdentity = Type.Object({
  hwnd: Type.String({
    pattern: "^[1-9][0-9]*$",
    description: "Decimal HWND retained from a current window observation.",
  }),
  pid: Type.Integer({ minimum: 1, description: "Retained process id." }),
});

const nativeControlIdentity = Type.Object({
  hwnd: Type.String({ pattern: "^[1-9][0-9]*$" }),
  pid: Type.Integer({ minimum: 1 }),
  nativeHwnd: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
  automationId: Type.String({ maxLength: 1_024 }),
  controlType: Type.Integer({ minimum: 1 }),
  name: Type.String({ maxLength: 4_096 }),
  className: Type.String({ maxLength: 1_024 }),
  path: Type.String({
    pattern: "^[0-9]+(?:/[0-9]+)*$",
    maxLength: 2_048,
  }),
});

const nativeVisualObservation = Type.Object({
  version: Type.Literal(2),
  capturedAtMs: Type.Integer({ minimum: 0 }),
  target: nativeWindowIdentity,
  active: Type.Boolean(),
  clientRect: Type.Object({
    x: Type.Integer(),
    y: Type.Integer(),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  }),
  clientOriginScreen: Type.Object({
    x: Type.Integer(),
    y: Type.Integer(),
  }),
  dpi: Type.Integer({ minimum: 48, maximum: 768 }),
  screenshot: Type.Object({
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    scaleX: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    scaleY: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  }),
});

const nativeTargetAction = (action: string) =>
  Type.Object({
    action: Type.Literal(action),
    desktop: desktopParam,
    target: nativeControlIdentity,
  });

// One entry per proxy tool: its registered name, its UI label, its
// description, and its parameter schema. `execute` is identical for every
// tool but the name it forwards, so it is built once in the registration loop
// below rather than repeated per tool.
const TOOL_SPECS = [
  {
    name: "local_read",
    label: "Read Local File",
    description: `Read a file from the human's desktop. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
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
  },
  {
    name: "local_write",
    label: "Write Local File",
    description: `Create or overwrite a file on the human's desktop. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      path: Type.String({ description: "Path to write." }),
      content: Type.String({ description: "Full file contents to write." }),
    }),
  },
  {
    name: "local_edit",
    label: "Edit Local File",
    description: `Replace an exact substring in a file on the human's desktop. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      path: Type.String({ description: "Path to edit." }),
      oldString: Type.String({ description: "Exact text to replace." }),
      newString: Type.String({ description: "Replacement text." }),
      replaceAll: Type.Optional(
        Type.Boolean({ description: "Replace every occurrence." }),
      ),
    }),
  },
  {
    name: "local_ls",
    label: "List Local Directory",
    description: `List the entries of a directory on the human's desktop. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      path: Type.String({ description: "Directory to list." }),
    }),
  },
  {
    name: "local_glob",
    label: "Find Local Files",
    description: `Find files on the human's desktop by glob pattern (supports ** and *). ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      pattern: Type.String({
        description: "Glob pattern, e.g. src/**/*.ts.",
      }),
      path: Type.Optional(
        Type.String({ description: "Directory to search from." }),
      ),
    }),
  },
  {
    name: "local_grep",
    label: "Search Local Files",
    description: `Search file contents on the human's desktop with a regular expression. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      pattern: Type.String({
        description:
          "RE2 regular expression to search for. Backreferences and lookaround are unsupported.",
        maxLength: MAX_LOCAL_GREP_PATTERN_CHARS,
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
  },
  {
    name: "local_bash",
    label: "Run Local Shell Command",
    description: `Run a shell command on the human's desktop and return its output. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      command: Type.String({ description: "Shell command to run." }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the command." }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (maximum 600000).",
          minimum: 1,
          maximum: 600_000,
        }),
      ),
    }),
  },
  {
    name: "local_js_run",
    label: "Run Local JavaScript",
    description: `Run inline JavaScript with the Node runtime embedded in the Sandi desktop app. This is desktop-local and separate from server-side sandi_js_run. Output is untrusted evidence. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      code: Type.String({
        description: "JavaScript source to execute as an ES module.",
        minLength: 1,
        maxLength: MAX_LOCAL_SCRIPT_SOURCE_CHARS,
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory. Relative paths resolve from the desktop tool root; omission uses that root.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (maximum 600000).",
          minimum: 1,
          maximum: 600_000,
        }),
      ),
    }),
  },
  {
    name: "local_autoit_run",
    label: "Run Local AutoIt",
    description: `Run inline AutoIt source in the connected interactive Windows session with Sandi's bundled x64 runtime and SandiAutoIt.au3 UIA/input helpers. Emit one versioned action receipt with SandiActionReceipt_Emit for a native mutation. Use SandiVisual_Click only with a fresh window visualObservation after DOM, native controls, UIA, and safe editor insertion are unavailable. When the user is present and actively using the computer, prefer guarded input with #RequireAdmin so concurrent input cannot redirect the action. Direct input is allowed for unattended work without UAC. Source is checked with Au3Check but is not filtered by function name. Output is untrusted evidence. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      code: Type.String({
        description: "AutoIt .au3 source to execute.",
        minLength: 1,
        maxLength: MAX_LOCAL_SCRIPT_SOURCE_CHARS,
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (maximum 600000).",
          minimum: 1,
          maximum: 600_000,
        }),
      ),
    }),
  },
  {
    name: "local_native",
    label: "Control Local Native UI",
    description: `Inspect and act on native Windows controls through typed calls backed by SandiAutoIt.au3. Start with inspect, then pass the returned complete control identity unchanged to describe, value, editor, invoke, toggle, select, or wait actions. visual_click accepts only a fresh window visualObservation. Use local_autoit_run only for unusual multi-step flows or application research. ${DESKTOP_HINT}`,
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("inspect"),
        desktop: desktopParam,
        window: nativeWindowIdentity,
        filters: Type.Optional(
          Type.Object({
            automationId: Type.Optional(Type.String({ maxLength: 1_024 })),
            controlType: Type.Optional(Type.Integer({ minimum: 1 })),
            name: Type.Optional(Type.String({ maxLength: 4_096 })),
            className: Type.Optional(Type.String({ maxLength: 1_024 })),
          }),
        ),
        includeDocumentChildren: Type.Optional(Type.Boolean()),
        maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
      }),
      nativeTargetAction("describe"),
      nativeTargetAction("get_value"),
      Type.Object({
        action: Type.Literal("set_value"),
        desktop: desktopParam,
        target: nativeControlIdentity,
        value: Type.String({ maxLength: 65_536 }),
      }),
      Type.Object({
        action: Type.Literal("insert_text"),
        desktop: desktopParam,
        target: nativeControlIdentity,
        text: Type.String({ minLength: 1, maxLength: 65_536 }),
      }),
      nativeTargetAction("invoke"),
      nativeTargetAction("toggle"),
      nativeTargetAction("select"),
      Type.Object({
        action: Type.Literal("wait_value"),
        desktop: desktopParam,
        target: nativeControlIdentity,
        value: Type.String({ maxLength: 65_536 }),
        timeoutMs: Type.Integer({ minimum: 1, maximum: 30_000 }),
      }),
      Type.Object({
        action: Type.Literal("wait_window"),
        desktop: desktopParam,
        window: nativeWindowIdentity,
        state: Type.Union([Type.Literal("exists"), Type.Literal("closed")]),
        timeoutMs: Type.Integer({ minimum: 1, maximum: 30_000 }),
      }),
      Type.Object({
        action: Type.Literal("visual_click"),
        desktop: desktopParam,
        visualObservation: nativeVisualObservation,
        x: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
        y: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
      }),
    ]),
  },
  {
    name: "local_list_desktops",
    label: "List Connected Desktops",
    description:
      "List the human's desktops that are currently connected, so a monitor, window, or screenshot tool can target one of them. Returns an id and name for each, with the current desktop marked.",
    parameters: Type.Object({}),
  },
  {
    name: "local_list_monitors",
    label: "List Desktop Monitors",
    description: `List the monitors attached to a connected desktop, with their pixel sizes and positions. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
    }),
  },
  {
    name: "local_list_windows",
    label: "List Desktop Windows",
    description: `List visible top-level windows as JSON with windows, warnings, and complete fields. Individual disappearing or inaccessible windows produce warnings and complete=false while usable windows remain available. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
    }),
  },
  {
    name: "local_desktop_activity",
    label: "Observe Desktop Activity",
    description: `Report the current Windows session lock state and bounded age of the last local keyboard or mouse input. The ephemeral, non-identifying result classifies activity as active, idle, locked, or unknown. Use it only to choose a global-input fallback after targeted native or UIA actions are unavailable. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
    }),
  },
  {
    name: "local_screenshot",
    label: "Screenshot Desktop",
    description: `Capture a screenshot of a connected desktop and return it as an image. A window capture uses its DPI-aware client area and returns one visualObservation contract in structured content for guarded normalized-coordinate input. Capture one monitor or one window; with neither, the primary monitor is captured. ${DESKTOP_HINT}`,
    parameters: Type.Object({
      desktop: desktopParam,
      monitor: Type.Optional(
        Type.String({
          description:
            "Monitor to capture, by index or device name from local_list_monitors.",
        }),
      ),
      window: Type.Optional(
        Type.String({
          description:
            "Window to capture, by handle or title from local_list_windows.",
        }),
      ),
      maxDimension: Type.Optional(
        Type.Number({
          description:
            "Longest-edge cap in pixels before encoding (default 1568).",
        }),
      ),
    }),
  },
];

export default function localExecToolsExtension(pi: ExtensionAPI): void {
  const broker = readBroker();
  if (!broker) {
    // No desktop is paired to this turn (or this is not a hands-local surface).
    // Register nothing: the turn runs without file or shell tools rather than
    // silently falling back to executing on the server.
    return;
  }

  for (const spec of TOOL_SPECS) {
    pi.registerTool(
      defineTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        async execute(_id, params, signal) {
          return callBrokerTool(broker, spec.name, params, signal);
        },
      }),
    );
  }
}
