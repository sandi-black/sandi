import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { path7za } from "7zip-bin";

import { readRuntimeLock, verifyManifest } from "./mcp-runtime-lib.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("packaged MCP runtimes are verified only on Windows x64");
}

const appRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8"),
);
const lock = readRuntimeLock(join(appRoot, "mcp-runtime", "runtime-lock.json"));
const inspectionRoot = join(appRoot, "build", "packaged runtime inspection");
const tsxCli = resolve(appRoot, "..", "node_modules", "tsx", "dist", "cli.mjs");
const targets = [
  {
    name: "nsis",
    artifact: join(
      appRoot,
      "release",
      `Sandi-${packageJson.version}-setup.exe`,
    ),
  },
  {
    name: "portable",
    artifact: join(
      appRoot,
      "release",
      `Sandi-${packageJson.version}-portable.exe`,
    ),
  },
];

rmSync(inspectionRoot, { recursive: true, force: true });
mkdirSync(inspectionRoot, { recursive: true });
try {
  let expectedManifestSha256;
  for (const target of targets) {
    const extracted = join(inspectionRoot, `${target.name} target with spaces`);
    mkdirSync(extracted, { recursive: true });
    run(path7za, ["x", target.artifact, `-o${extracted}`, "-y"]);
    const runtimeRoot = join(extracted, "resources", "mcp");
    await verifyManifest(runtimeRoot, lock);
    const manifestSha256 = sha256(
      readFileSync(join(runtimeRoot, "manifest.json")),
    );
    expectedManifestSha256 ??= manifestSha256;
    assert.equal(
      manifestSha256,
      expectedManifestSha256,
      `${target.name} contains a different MCP payload`,
    );
    run(
      process.execPath,
      [
        tsxCli,
        "--tsconfig",
        "tsconfig.node.json",
        "scripts/verify-packaged-app-mcp.ts",
      ],
      {
        ...process.env,
        SANDI_PACKAGED_APP_ROOT: extracted,
      },
    );
  }
  console.log(
    `verified packaged MCP runtimes: manifest=${expectedManifestSha256} targets=${targets.length}`,
  );
} finally {
  rmSync(inspectionRoot, {
    recursive: true,
    force: true,
    maxRetries: 200,
    retryDelay: 100,
  });
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit code ${String(result.status)}`,
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
