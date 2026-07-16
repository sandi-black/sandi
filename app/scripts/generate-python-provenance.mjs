import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  normalizePythonName,
  parsePythonRequirements,
} from "./python-provenance-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(appRoot, "mcp-runtime", "windows-mcp");
const requirements = parsePythonRequirements(
  readFileSync(join(sourceRoot, "requirements.lock"), "utf8"),
);
const notices = JSON.parse(
  readFileSync(join(appRoot, "build", "mcp", "THIRD_PARTY_NOTICES.json")),
).packages.filter((entry) => entry.ecosystem === "python");
const noticesByName = new Map(
  notices.map((entry) => [normalizePythonName(entry.name), entry]),
);

const packages = await mapConcurrent(requirements, 8, async (requirement) => {
  const notice = noticesByName.get(requirement.normalizedName);
  if (!notice || notice.version !== requirement.version) {
    throw new Error(`staged notice is missing ${requirement.name}`);
  }
  const response = await fetch(
    `https://pypi.org/pypi/${encodeURIComponent(requirement.name)}/${encodeURIComponent(requirement.version)}/json`,
  );
  if (!response.ok) {
    throw new Error(`PyPI metadata failed for ${requirement.name}`);
  }
  const release = await response.json();
  const allowedHashes = new Set(requirement.hashes);
  const artifacts = release.urls
    .filter((file) => allowedHashes.has(file.digests?.sha256))
    .map((file) => ({
      url: file.url,
      sha256: file.digests.sha256,
      packageType: file.packagetype,
    }))
    .sort((left, right) => left.url.localeCompare(right.url));
  if (artifacts.length !== allowedHashes.size) {
    throw new Error(
      `PyPI did not return every locked artifact for ${requirement.name}`,
    );
  }
  return {
    name: notice.name,
    version: notice.version,
    license: notice.license,
    licenseFiles: [...notice.licenseFiles].sort(),
    artifacts,
  };
});

packages.sort((left, right) =>
  normalizePythonName(left.name).localeCompare(normalizePythonName(right.name)),
);
writeFileSync(
  join(sourceRoot, "provenance.json"),
  `${JSON.stringify({ version: 1, index: "https://pypi.org", packages }, null, 2)}\n`,
);
console.log(`recorded Python provenance for ${packages.length} packages`);

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}
