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
  executable: (root: string) => string;
  argsPrefix: (root: string) => string[];
  requiredFiles: string[];
};

const definitions: Record<string, CommandDefinition> = {
  node: bundledExecutable("node/node.exe"),
  uv: bundledExecutable("uv/uv.exe"),
  python: bundledExecutable("python/python.exe"),
  "chrome-devtools-mcp": {
    executable: (root) => bundledPath(root, "node/node.exe"),
    argsPrefix: (root) => [
      bundledPath(
        root,
        "servers/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      ),
    ],
    requiredFiles: [
      "node/node.exe",
      "servers/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    ],
  },
  "windows-mcp": {
    executable: (root) => bundledPath(root, "servers/windows-mcp/launch.cmd"),
    argsPrefix: () => [],
    requiredFiles: [
      "python/python.exe",
      "servers/windows-mcp/launch.cmd",
      "servers/windows-mcp/launch.py",
      "servers/windows-mcp/site-packages/windows_mcp/__main__.py",
    ],
  },
};

export type BundledMcpCommandRegistry = {
  resolve(id: string): Promise<BundledMcpCommand | undefined>;
};

export function createBundledMcpCommandRegistry(input: {
  resourcesRoot: string;
  userDataDir: string;
}): BundledMcpCommandRegistry {
  const root = join(input.resourcesRoot, "mcp");
  let verified:
    | Promise<{
        manifest: Manifest;
        manifestSha256: string;
      }>
    | undefined;

  return {
    async resolve(id) {
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
      const env = await commandEnvironment(input.userDataDir, root);
      return {
        id,
        version: command.version,
        manifestSha256: result.manifestSha256,
        executable: definition.executable(root),
        argsPrefix: definition.argsPrefix(root),
        env,
      };
    },
  };
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
  root: string,
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
    PATH: [
      join(root, "node"),
      join(root, "uv"),
      join(systemRoot, "System32"),
    ].join(";"),
    PYTHONDONTWRITEBYTECODE: "1",
    SANDI_MCP_STATE_DIR: state,
    SystemRoot: systemRoot,
    TEMP: temp,
    TMP: temp,
    USERPROFILE: profile,
    WINDIR: systemRoot,
  };
}

function bundledExecutable(path: string): CommandDefinition {
  return {
    executable: (root) => bundledPath(root, path),
    argsPrefix: () => [],
    requiredFiles: [path],
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
