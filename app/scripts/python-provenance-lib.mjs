const SHA256 = /^[0-9a-f]{64}$/;

export function parsePythonRequirements(contents) {
  const packages = [];
  let current;
  for (const line of contents.split(/\r?\n/)) {
    const requirement = /^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\?$/.exec(line);
    if (requirement) {
      current = {
        name: requirement[1],
        normalizedName: normalizePythonName(requirement[1]),
        version: requirement[2],
        hashes: [],
      };
      packages.push(current);
      continue;
    }
    const hash = /--hash=sha256:([0-9a-f]{64})/.exec(line)?.[1];
    if (hash && current) current.hashes.push(hash);
  }
  for (const entry of packages) {
    if (entry.hashes.length === 0) {
      throw new Error(`Python requirement ${entry.name} has no hashes`);
    }
    entry.hashes.sort();
  }
  packages.sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName),
  );
  return packages;
}

export function verifyPythonProvenance(
  provenance,
  requirementsContents,
  bundledPackages,
) {
  if (provenance.version !== 1 || provenance.index !== "https://pypi.org") {
    throw new Error("unsupported Python provenance ledger");
  }
  const requirements = parsePythonRequirements(requirementsContents);
  const notices = new Map(
    bundledPackages
      .filter((entry) => entry.ecosystem === "python")
      .map((entry) => [normalizePythonName(entry.name), entry]),
  );
  if (
    provenance.packages.length !== requirements.length ||
    notices.size !== requirements.length
  ) {
    throw new Error("Python provenance package set does not match the lock");
  }
  for (const [index, requirement] of requirements.entries()) {
    const entry = provenance.packages[index];
    const notice = notices.get(requirement.normalizedName);
    if (
      normalizePythonName(entry?.name ?? "") !== requirement.normalizedName ||
      entry.version !== requirement.version ||
      notice?.version !== requirement.version
    ) {
      throw new Error(`Python provenance drifted for ${requirement.name}`);
    }
    if (
      entry.license !== notice.license ||
      JSON.stringify(entry.licenseFiles) !==
        JSON.stringify([...notice.licenseFiles].sort())
    ) {
      throw new Error(`Python license provenance drifted for ${entry.name}`);
    }
    if (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0) {
      throw new Error(`Python provenance has no artifacts for ${entry.name}`);
    }
    const allowedHashes = new Set(requirement.hashes);
    const recordedHashes = new Set();
    for (const artifact of entry.artifacts) {
      if (
        typeof artifact.url !== "string" ||
        !artifact.url.startsWith("https://files.pythonhosted.org/") ||
        (artifact.packageType !== "bdist_wheel" &&
          artifact.packageType !== "sdist") ||
        !SHA256.test(artifact.sha256 ?? "") ||
        !allowedHashes.has(artifact.sha256) ||
        recordedHashes.has(artifact.sha256)
      ) {
        throw new Error(
          `Python artifact provenance is invalid for ${entry.name}`,
        );
      }
      recordedHashes.add(artifact.sha256);
    }
    if (
      recordedHashes.size !== allowedHashes.size ||
      requirement.hashes.some((hash) => !recordedHashes.has(hash))
    ) {
      throw new Error(
        `Python artifact provenance is incomplete for ${entry.name}`,
      );
    }
  }
}

export function normalizePythonName(name) {
  return name.toLowerCase().replaceAll(/[-_.]+/g, "-");
}
