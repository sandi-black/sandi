import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;

export function readRuntimeLock(path) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  if (lock.version !== 1 || lock.target !== "win32-x64") {
    throw new Error("unsupported MCP runtime lock");
  }
  for (const [name, artifact] of Object.entries(lock.artifacts ?? {})) {
    validateDownload(`${name} artifact`, artifact);
    validateDownload(`${name} license`, artifact.license);
    if (typeof artifact.version !== "string" || artifact.version.length === 0) {
      throw new Error(`${name} version is missing`);
    }
  }
  const requiredCommands = ["autoit", "chrome-devtools-mcp"];
  for (const id of requiredCommands) {
    if (typeof lock.commands?.[id]?.version !== "string") {
      throw new Error(`MCP runtime lock is missing command ${id}`);
    }
  }
  return lock;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildManifest(root, lock) {
  const files = [];
  for (const path of regularFiles(root)) {
    if (relative(root, path) === "manifest.json") continue;
    files.push({
      path: relative(root, path).split(sep).join("/"),
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    target: lock.target,
    commands: lock.commands,
    files,
  };
}

export async function verifyManifest(root, lock) {
  const path = resolve(root, "manifest.json");
  if (!existsSync(path)) throw new Error("MCP runtime manifest is missing");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== 1 || manifest.target !== lock.target) {
    throw new Error("MCP runtime manifest target does not match its lock");
  }
  const expected = await buildManifest(root, lock);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("MCP runtime manifest does not match the staged files");
  }
  return manifest;
}

function validateDownload(label, artifact) {
  if (
    typeof artifact?.url !== "string" ||
    !artifact.url.startsWith("https://") ||
    !SHA256.test(artifact.sha256 ?? "")
  ) {
    throw new Error(`${label} must have an HTTPS URL and SHA256`);
  }
}

function regularFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`MCP runtime contains unsupported entry ${path}`);
    }
  };
  visit(root);
  return files;
}
