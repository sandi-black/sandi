import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  defaultPiFeedbackExtensionPath,
  defaultPiImagegenExtensionPath,
  defaultPiJsRunExtensionPath,
  defaultPiMemoryExtensionPath,
  defaultPiPolicyExtensionPath,
  defaultPiSkillExtensionPath,
  defaultPiStopExtensionPath,
  defaultPiTokenUsageExtensionPath,
} from "@/lib/provider/pi-cli-client";
import { spawnCommandIgnoringStdin } from "@/lib/provider/spawn-command";

const piCommand = resolve("node_modules/.bin/pi");
const invalidProvider = "__sandi_extension_load_probe__";
const extensionPaths = [
  defaultPiJsRunExtensionPath(),
  defaultPiMemoryExtensionPath(),
  defaultPiSkillExtensionPath(),
  defaultPiFeedbackExtensionPath(),
  defaultPiPolicyExtensionPath(),
  defaultPiImagegenExtensionPath(),
  defaultPiStopExtensionPath(),
  defaultPiTokenUsageExtensionPath(),
];

for (const extensionPath of extensionPaths) {
  assert.ok(existsSync(extensionPath), `missing extension: ${extensionPath}`);
}

const args = ["--print", "--no-session"];
for (const extensionPath of extensionPaths) {
  args.push("--extension", extensionPath);
}
args.push(
  "--provider",
  invalidProvider,
  "--model",
  invalidProvider,
  "probe extension loading only",
);

const result = await runPi(args);
const output = `${result.stdout}\n${result.stderr}`;

assert.notEqual(result.exitCode, 0, "probe should stop before provider turn");
assert.match(
  output,
  /Unknown provider "__sandi_extension_load_probe__"/,
  "expected Pi to reach provider validation after loading extensions",
);
assert.doesNotMatch(output, /Failed to load extension/i);

console.log("Pi extension load verification passed");

async function runPi(args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawnCommandIgnoringStdin(piCommand, args, {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}
