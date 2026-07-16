import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildManifest,
  readRuntimeLock,
  verifyManifest,
} from "./mcp-runtime-lib.mjs";
import { verifyPythonProvenance } from "./python-provenance-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const lockPath = join(appRoot, "mcp-runtime", "runtime-lock.json");
const lock = readRuntimeLock(lockPath);
const root = mkdtempSync(join(tmpdir(), "sandi-mcp-runtime-verifier-"));
try {
  const corruptLock = join(root, "runtime-lock.json");
  writeFileSync(
    corruptLock,
    JSON.stringify({
      ...lock,
      artifacts: {
        ...lock.artifacts,
        node: { ...lock.artifacts.node, sha256: "bad" },
      },
    }),
  );
  assert.throws(() => readRuntimeLock(corruptLock), /SHA256/);

  writeFileSync(join(root, "payload.txt"), "Grace Hopper\n");
  const manifest = await buildManifest(root, lock);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  await verifyManifest(root, lock);
  writeFileSync(join(root, "payload.txt"), "Ada Lovelace\n");
  await assert.rejects(() => verifyManifest(root, lock), /does not match/);

  const firstHash = "1".repeat(64);
  const secondHash = "2".repeat(64);
  const requirements = `ada-example==1.0 \\\n+    --hash=sha256:${firstHash} \\\n+    --hash=sha256:${secondHash}\n`;
  const provenance = {
    version: 1,
    index: "https://pypi.org",
    packages: [
      {
        name: "ada-example",
        version: "1.0",
        license: "MIT",
        licenseFiles: ["LICENSE"],
        artifacts: [
          {
            url: "https://files.pythonhosted.org/ada-example-1.0.whl",
            sha256: firstHash,
            packageType: "bdist_wheel",
          },
          {
            url: "https://files.pythonhosted.org/ada-example-1.0.tar.gz",
            sha256: secondHash,
            packageType: "sdist",
          },
        ],
      },
    ],
  };
  const notices = [
    {
      ecosystem: "python",
      name: "ada-example",
      version: "1.0",
      license: "MIT",
      licenseFiles: ["LICENSE"],
    },
  ];
  verifyPythonProvenance(provenance, requirements, notices);
  provenance.packages[0].artifacts.pop();
  assert.throws(
    () => verifyPythonProvenance(provenance, requirements, notices),
    /incomplete/,
  );
  console.log("MCP runtime preparation verification passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
