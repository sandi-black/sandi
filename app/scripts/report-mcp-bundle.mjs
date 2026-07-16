import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { sha256File } from "./mcp-runtime-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const manifestPath = join(appRoot, "build", "mcp", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestSha256 = await sha256File(manifestPath);
const payloadBytes = manifest.files.reduce(
  (total, file) => total + file.bytes,
  0,
);
const artifacts = readdirSync(join(appRoot, "release"))
  .filter((name) => name.endsWith(".exe"))
  .sort()
  .map((name) => ({
    name,
    bytes: statSync(join(appRoot, "release", name)).size,
  }));

const lines = [
  "## Bundled MCP runtimes",
  "",
  `Manifest SHA256: \`${manifestSha256}\``,
  `Payload: ${formatBytes(payloadBytes)} across ${manifest.files.length} files`,
  "",
  "| Command | Version |",
  "| --- | --- |",
  ...Object.entries(manifest.commands).map(
    ([id, command]) => `| ${id} | ${command.version} |`,
  ),
  "",
  "| Artifact | Size |",
  "| --- | ---: |",
  ...artifacts.map(
    (artifact) => `| ${artifact.name} | ${formatBytes(artifact.bytes)} |`,
  ),
  "",
];
const report = lines.join("\n");
console.log(report);
const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
if (summaryPath) appendFileSync(summaryPath, report);

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
