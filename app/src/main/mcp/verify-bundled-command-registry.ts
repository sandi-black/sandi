import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createBundledMcpCommandRegistry } from "./bundled-command-registry";

const versions: Record<string, string> = {
  node: "24.18.0",
  uv: "0.11.29",
  python: "3.13.14",
  "chrome-devtools-mcp": "1.6.0",
  "windows-mcp": "0.8.2",
};

const root = mkdtempSync(join(tmpdir(), "sandi bundled registry "));
try {
  const resources = join(root, "relocated resources with spaces");
  const userData = join(root, "user data");
  writeBundle(resources);
  const registry = createBundledMcpCommandRegistry({
    resourcesRoot: resources,
    userDataDir: userData,
  });
  const ids = ["node", "uv", "python", "chrome-devtools-mcp", "windows-mcp"];
  for (const id of ids) {
    const command = await registry.resolve(id);
    assert(command, `${id} resolves`);
    assert.equal(command.id, id);
    assert.equal(command.version, versions[id]);
    assert.match(command.manifestSha256 ?? "", /^[0-9a-f]{64}$/);
    assert(command.env?.["PATH"]?.startsWith(join(resources, "mcp", "node")));
    assert.equal(
      command.env?.["SANDI_MCP_STATE_DIR"],
      join(userData, "mcp-runtime", "state"),
    );
  }
  assert.equal(await registry.resolve("unknown"), undefined);
  assert(
    (await registry.resolve("chrome-devtools-mcp"))?.argsPrefix[0]?.includes(
      "relocated resources with spaces",
    ),
  );
  assert(
    (await registry.resolve("windows-mcp"))?.executable.includes(
      "relocated resources with spaces",
    ),
  );

  const corruptResources = join(root, "corrupt resources");
  writeBundle(corruptResources);
  writeFileSync(join(corruptResources, "mcp", "node", "node.exe"), "corrupt");
  await assert.rejects(
    () =>
      createBundledMcpCommandRegistry({
        resourcesRoot: corruptResources,
        userDataDir: join(root, "corrupt user"),
      }).resolve("node"),
    /failed verification/,
  );

  const missingResources = join(root, "missing resources");
  writeBundle(missingResources);
  rmSync(join(missingResources, "mcp", "python", "python.exe"));
  await assert.rejects(
    () =>
      createBundledMcpCommandRegistry({
        resourcesRoot: missingResources,
        userDataDir: join(root, "missing user"),
      }).resolve("windows-mcp"),
    /component python\/python.exe is unavailable/,
  );
  console.log("verify-bundled-command-registry: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeBundle(resourcesRoot: string): void {
  const bundle = join(resourcesRoot, "mcp");
  const files: Record<string, string> = {
    "node/node.exe": "node",
    "uv/uv.exe": "uv",
    "python/python.exe": "python",
    "servers/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js":
      "chrome",
    "servers/windows-mcp/launch.cmd": "launcher",
    "servers/windows-mcp/launch.py": "launcher",
    "servers/windows-mcp/site-packages/windows_mcp/__main__.py": "windows",
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(bundle, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const manifest = {
    version: 1,
    target: "win32-x64",
    commands: Object.fromEntries(
      Object.entries(versions).map(([id, version]) => [id, { version }]),
    ),
    files: Object.keys(files)
      .sort()
      .map((path) => {
        const contents = readFileSync(join(bundle, ...path.split("/")));
        return {
          path,
          bytes: contents.byteLength,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
      }),
  };
  writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}
