import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BundledMcpCommand } from "./mcp-host";
import { z } from "zod/v4";

const ManifestSchema = z.object({
  version: z.literal(1),
  target: z.literal("win32-x64"),
  commands: z.record(z.string(), z.object({ version: z.string().min(1) })),
  files: z.array(
    z.object({
      path: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

type Manifest = z.infer<typeof ManifestSchema>;
type CommandDefinition = {
  executable: (root: string, electronExecutable: string) => string;
  argsPrefix: (root: string) => string[];
  argsSuffix?: (
    root: string,
    configuredArgs: readonly string[],
    realLocalAppData: string | undefined,
  ) => string[];
  env?: Record<string, string>;
  requiredFiles: string[];
};

const CHROME_USER_DATA_DIRECTORIES: Readonly<
  Record<string, readonly string[]>
> = {
  stable: ["Google", "Chrome", "User Data"],
  beta: ["Google", "Chrome Beta", "User Data"],
  dev: ["Google", "Chrome Dev", "User Data"],
  canary: ["Google", "Chrome SxS", "User Data"],
};

const CHROME_CONNECTION_OPTIONS = [
  "--userDataDir",
  "--user-data-dir",
  "--browserUrl",
  "--browser-url",
  "-u",
  "--wsEndpoint",
  "--ws-endpoint",
  "-w",
] as const;

const definitions: Record<string, CommandDefinition> = {
  "chrome-devtools-mcp": {
    executable: (_root, electronExecutable) => electronExecutable,
    argsPrefix: (root) => [
      bundledPath(
        root,
        "servers/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      ),
    ],
    argsSuffix: (_root, configuredArgs, realLocalAppData) =>
      chromeAutoConnectProfileArgs(configuredArgs, realLocalAppData),
    requiredFiles: [
      "servers/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  },
  autoit: {
    executable: (root) => bundledPath(root, "autoit/AutoIt3_x64.exe"),
    argsPrefix: () => [],
    requiredFiles: [
      "autoit/AutoIt3_x64.exe",
      "autoit/Au3Check.exe",
      "autoit/Au3Check.dat",
      "autoit/Include/AutoItConstants.au3",
      "autoit/Include/SandiAutoIt.au3",
    ],
  },
};

export type BundledMcpCommandRegistry = {
  resolve(
    id: string,
    configuredArgs: readonly string[],
  ): Promise<BundledMcpCommand | undefined>;
};

export function createBundledMcpCommandRegistry(input: {
  resourcesRoot: string;
  userDataDir: string;
  realLocalAppData: string | undefined;
  electronExecutable: string;
}): BundledMcpCommandRegistry {
  const root = join(input.resourcesRoot, "mcp");
  let verified:
    | Promise<{
        manifest: Manifest;
        manifestSha256: string;
      }>
    | undefined;

  return {
    async resolve(id, configuredArgs) {
      const definition = definitions[id];
      if (!definition) return undefined;
      if (!verified) verified = verifyBundle(root);
      const result = await verified;
      const command = result.manifest.commands[id];
      if (!command) {
        throw new Error(`bundled MCP manifest does not declare command ${id}`);
      }
      const files = new Set(result.manifest.files.map((file) => file.path));
      for (const required of definition.requiredFiles) {
        if (!files.has(required)) {
          throw new Error(
            `bundled MCP command ${id} is missing required component ${required}`,
          );
        }
      }
      const env = await commandEnvironment(input.userDataDir);
      return {
        id,
        version: command.version,
        manifestSha256: result.manifestSha256,
        executable: definition.executable(root, input.electronExecutable),
        argsPrefix: definition.argsPrefix(root),
        argsSuffix:
          definition.argsSuffix?.(
            root,
            configuredArgs,
            input.realLocalAppData,
          ) ?? [],
        env: { ...env, ...definition.env },
      };
    },
  };
}

export function resolveRealLocalAppData(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const localAppData = environment["LOCALAPPDATA"];
  if (localAppData) return localAppData;
  const userProfile = environment["USERPROFILE"];
  return userProfile ? join(userProfile, "AppData", "Local") : undefined;
}

function chromeAutoConnectProfileArgs(
  configuredArgs: readonly string[],
  realLocalAppData: string | undefined,
): string[] {
  if (
    !configuredArgs.includes("--autoConnect") ||
    hasOption(configuredArgs, CHROME_CONNECTION_OPTIONS) ||
    !realLocalAppData
  ) {
    return [];
  }
  const channel = optionValue(configuredArgs, "--channel") ?? "stable";
  const directory = CHROME_USER_DATA_DIRECTORIES[channel];
  return directory
    ? ["--userDataDir", join(realLocalAppData, ...directory)]
    : [];
}

function hasOption(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );
}

function optionValue(
  args: readonly string[],
  name: string,
): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

async function verifyBundle(root: string): Promise<{
  manifest: Manifest;
  manifestSha256: string;
}> {
  let raw: Buffer;
  try {
    raw = await readFile(join(root, "manifest.json"));
  } catch (error) {
    throw new Error(`bundled MCP manifest is unavailable: ${errorText(error)}`);
  }
  const manifest = ManifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) {
      throw new Error(`bundled MCP manifest repeats ${file.path}`);
    }
    seen.add(file.path);
    let contents: Buffer;
    try {
      contents = await readFile(bundledPath(root, file.path));
    } catch (error) {
      throw new Error(
        `bundled MCP component ${file.path} is unavailable: ${errorText(error)}`,
      );
    }
    if (
      contents.byteLength !== file.bytes ||
      sha256(contents) !== file.sha256
    ) {
      throw new Error(`bundled MCP component ${file.path} failed verification`);
    }
  }
  return { manifest, manifestSha256: sha256(raw) };
}

async function commandEnvironment(
  userDataDir: string,
): Promise<Record<string, string>> {
  const profile = join(userDataDir, "mcp-runtime", "profile");
  const local = join(profile, "Local");
  const roaming = join(profile, "Roaming");
  const state = join(userDataDir, "mcp-runtime", "state");
  const temp = join(userDataDir, "mcp-runtime", "temp");
  await Promise.all(
    [profile, local, roaming, state, temp].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return {
    APPDATA: roaming,
    LOCALAPPDATA: local,
    PATH: [join(systemRoot, "System32")].join(";"),
    SANDI_MCP_STATE_DIR: state,
    ...(process.env["SANDI_MCP_OFFLINE_TEST"] === "1"
      ? { SANDI_MCP_OFFLINE_TEST: "1" }
      : {}),
    SystemRoot: systemRoot,
    TEMP: temp,
    TMP: temp,
    USERPROFILE: profile,
    WINDIR: systemRoot,
  };
}

function bundledPath(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
