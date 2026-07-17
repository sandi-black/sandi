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

import {
  createBundledMcpCommandRegistry,
  resolveRealLocalAppData,
  WINDOWS_MCP_UI_TOOLS,
} from "./bundled-command-registry";

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
  const realLocalAppData = join(root, "real local app data");
  writeBundle(resources);
  const registry = createBundledMcpCommandRegistry({
    resourcesRoot: resources,
    userDataDir: userData,
    realLocalAppData,
  });
  const ids = ["node", "uv", "python", "chrome-devtools-mcp", "windows-mcp"];
  for (const id of ids) {
    const command = await registry.resolve(id, []);
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
  assert.equal(await registry.resolve("unknown", []), undefined);
  assert(
    (
      await registry.resolve("chrome-devtools-mcp", [])
    )?.argsPrefix[0]?.includes("relocated resources with spaces"),
  );
  assert.deepEqual(
    (await registry.resolve("chrome-devtools-mcp", []))?.argsSuffix,
    [],
    "Chrome profiles are injected only for auto-connect",
  );
  const chromeCommand = await registry.resolve("chrome-devtools-mcp", [
    "--autoConnect",
  ]);
  assert.deepEqual(chromeCommand?.argsSuffix, [
    "--userDataDir",
    join(realLocalAppData, "Google", "Chrome", "User Data"),
  ]);
  assert.equal(
    chromeCommand?.env?.["LOCALAPPDATA"],
    join(userData, "mcp-runtime", "profile", "Local"),
    "Chrome MCP retains its isolated local app data",
  );
  assert.equal(
    chromeCommand?.env?.["USERPROFILE"],
    join(userData, "mcp-runtime", "profile"),
    "Chrome MCP retains its isolated user profile",
  );
  assert.notEqual(chromeCommand?.env?.["LOCALAPPDATA"], realLocalAppData);
  await verifyChromeProfiles(registry, realLocalAppData);
  assert(
    (await registry.resolve("windows-mcp", []))?.executable.includes(
      "relocated resources with spaces",
    ),
  );
  const windowsCommand = await registry.resolve("windows-mcp", [
    "--autoConnect",
    "--channel=canary",
  ]);
  assert.deepEqual(windowsCommand?.argsPrefix, []);
  assert.deepEqual(windowsCommand?.argsSuffix, [
    "--tools",
    WINDOWS_MCP_UI_TOOLS.join(","),
  ]);
  assert(
    !WINDOWS_MCP_UI_TOOLS.some((tool) =>
      [
        "PowerShell",
        "FileSystem",
        "Clipboard",
        "Process",
        "Registry",
        "Scrape",
      ].includes(tool),
    ),
    "the bundled Windows catalog contains only UI tools",
  );

  const corruptResources = join(root, "corrupt resources");
  writeBundle(corruptResources);
  writeFileSync(join(corruptResources, "mcp", "node", "node.exe"), "corrupt");
  await assert.rejects(
    () =>
      createBundledMcpCommandRegistry({
        resourcesRoot: corruptResources,
        userDataDir: join(root, "corrupt user"),
        realLocalAppData: undefined,
      }).resolve("node", []),
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
        realLocalAppData: undefined,
      }).resolve("windows-mcp", []),
    /component python\/python.exe is unavailable/,
  );
  const noRealProfile = createBundledMcpCommandRegistry({
    resourcesRoot: resources,
    userDataDir: join(root, "no real profile user"),
    realLocalAppData: undefined,
  });
  assert.deepEqual(
    (await noRealProfile.resolve("chrome-devtools-mcp", ["--autoConnect"]))
      ?.argsSuffix,
    [],
    "auto-connect falls back to the bundled process behavior when no real profile can be resolved",
  );
  assert.equal(
    resolveRealLocalAppData({
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      USERPROFILE: "C:\\Users\\Ignored",
    }),
    "C:\\Users\\Ada\\AppData\\Local",
  );
  assert.equal(
    resolveRealLocalAppData({ USERPROFILE: "C:\\Users\\Grace" }),
    join("C:\\Users\\Grace", "AppData", "Local"),
    "USERPROFILE provides the conventional Windows fallback",
  );
  assert.equal(resolveRealLocalAppData({}), undefined);
  console.log("verify-bundled-command-registry: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function verifyChromeProfiles(
  registry: ReturnType<typeof createBundledMcpCommandRegistry>,
  realLocalAppData: string,
): Promise<void> {
  const channels = {
    stable: ["Google", "Chrome", "User Data"],
    beta: ["Google", "Chrome Beta", "User Data"],
    dev: ["Google", "Chrome Dev", "User Data"],
    canary: ["Google", "Chrome SxS", "User Data"],
  } satisfies Record<string, string[]>;
  for (const [channel, directory] of Object.entries(channels)) {
    for (const channelArgs of [
      [`--channel=${channel}`],
      ["--channel", channel],
    ]) {
      assert.deepEqual(
        (
          await registry.resolve("chrome-devtools-mcp", [
            "--autoConnect",
            ...channelArgs,
          ])
        )?.argsSuffix,
        ["--userDataDir", join(realLocalAppData, ...directory)],
        `${channel} resolves from ${channelArgs.join(" ")}`,
      );
    }
  }

  for (const option of [
    "--userDataDir",
    "--user-data-dir",
    "--browserUrl",
    "--browser-url",
    "-u",
    "--wsEndpoint",
    "--ws-endpoint",
    "-w",
  ]) {
    for (const explicitArgs of [[option, "explicit"], [`${option}=explicit`]]) {
      assert.deepEqual(
        (
          await registry.resolve("chrome-devtools-mcp", [
            "--autoConnect",
            ...explicitArgs,
          ])
        )?.argsSuffix,
        [],
        `${explicitArgs.join(" ")} wins over the inferred profile`,
      );
    }
  }
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
