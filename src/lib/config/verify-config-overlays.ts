import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCoreConfig } from "@/lib/config/env";
import { ContextCompiler } from "@/lib/context/context-compiler";
import {
  listPoliciesFromRoots,
  readPolicyFromRoots,
} from "@/lib/context/policies";
import type { ConversationParticipant } from "@/lib/conversations/types";
import { loadHumanIdentities } from "@/lib/identity/resolver";
import { withTempDir } from "@/lib/verification/harness";

const previousEnv = saveEnv([
  "SANDI_CONFIG_DIR",
  "SANDI_DATA_DIR",
  "SANDI_PI_ACCOUNT_ROUTING_CONFIG",
  "SANDI_POLICY_ROOT",
  "SANDI_POLICY_ROOTS",
]);
const configDirToken = "$" + "{SANDI_CONFIG_DIR}";

try {
  await withTempDir("sandi-config-overlays-", async (tempRoot) => {
    const publicConfigDir = join(tempRoot, "public-config");
    const dataDir = join(tempRoot, "data");
    const privateConfigDir = join(dataDir, "config");
    await mkdir(join(publicConfigDir, "identities"), { recursive: true });
    await mkdir(join(privateConfigDir, "identities"), { recursive: true });
    await mkdir(join(publicConfigDir, "policies"), { recursive: true });
    await mkdir(join(privateConfigDir, "policies"), { recursive: true });

    await writeFile(join(publicConfigDir, "soul.md"), "public soul\n", "utf8");
    await writeFile(
      join(privateConfigDir, "soul.md"),
      "private soul\n",
      "utf8",
    );
    await writeFile(
      join(publicConfigDir, "identities", "humans.json"),
      JSON.stringify({
        version: 1,
        humans: [
          {
            id: "public-human",
            displayName: "Public Human",
            platforms: {
              github: {
                id: "public-github-id",
                login: "public-user",
              },
            },
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(privateConfigDir, "identities", "humans.json"),
      JSON.stringify({
        version: 1,
        humans: [
          {
            id: "private-human",
            displayName: "Private Human",
            platforms: {
              github: {
                id: "private-github-id",
                login: "private-user",
              },
            },
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(publicConfigDir, "policies", "shared.md"),
      "# Public Shared Policy\n",
      "utf8",
    );
    await writeFile(
      join(privateConfigDir, "policies", "shared.md"),
      "# Private Shared Policy\n",
      "utf8",
    );
    await writeFile(
      join(publicConfigDir, "policies", "fallback.md"),
      "# Public Fallback Policy\n",
      "utf8",
    );
    await writeFile(
      join(publicConfigDir, "pi-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [{ id: "public-account" }],
        routes: [{ identityId: "public-human", accountId: "public-account" }],
      }),
      "utf8",
    );
    await writeFile(
      join(privateConfigDir, "pi-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "private-account",
            agentDir: `${configDirToken}/private-agent`,
          },
        ],
        routes: [{ identityId: "private-human", accountId: "private-account" }],
      }),
      "utf8",
    );

    process.env["SANDI_CONFIG_DIR"] = publicConfigDir;
    process.env["SANDI_DATA_DIR"] = dataDir;
    delete process.env["SANDI_PI_ACCOUNT_ROUTING_CONFIG"];
    delete process.env["SANDI_POLICY_ROOT"];
    delete process.env["SANDI_POLICY_ROOTS"];

    const config = loadCoreConfig();
    const expectedPolicyRoots = config.paths.configDirs.map((configDir) =>
      join(configDir, "policies"),
    );
    assert.deepEqual(config.paths.configDirs, [
      privateConfigDir,
      publicConfigDir,
    ]);

    assert.equal(config.pi.accountRouting?.accounts[0]?.id, "private-account");
    assert.equal(
      config.pi.accountRouting?.accounts[0]?.agentDir,
      join(privateConfigDir, "private-agent"),
    );

    process.env["SANDI_POLICY_ROOT"] = join(publicConfigDir, "policies");
    process.env["SANDI_POLICY_ROOTS"] = join(publicConfigDir, "policies");
    process.env["SANDI_PI_ACCOUNT_ROUTING_CONFIG"] = join(
      publicConfigDir,
      "pi-accounts.json",
    );
    const ignoredLegacyPathEnvConfig = loadCoreConfig();
    assert.deepEqual(
      ignoredLegacyPathEnvConfig.paths.configDirs.map((configDir) =>
        join(configDir, "policies"),
      ),
      expectedPolicyRoots,
    );
    assert.equal(
      ignoredLegacyPathEnvConfig.pi.accountRouting?.accounts[0]?.id,
      "private-account",
    );
    delete process.env["SANDI_POLICY_ROOT"];
    delete process.env["SANDI_POLICY_ROOTS"];
    delete process.env["SANDI_PI_ACCOUNT_ROUTING_CONFIG"];

    const identities = await loadHumanIdentities(config.paths.configDirs);
    assert.equal(identities.humans[0]?.id, "private-human");

    const policies = await listPoliciesFromRoots(expectedPolicyRoots);
    assert.deepEqual(
      policies.map((policy) => `${policy.ref}:${policy.title}`),
      ["fallback.md:Public Fallback Policy", "shared.md:Private Shared Policy"],
    );
    assert.equal(
      await readPolicyFromRoots(expectedPolicyRoots, "shared.md"),
      "# Private Shared Policy\n",
    );

    const author: ConversationParticipant = {
      platform: "github",
      platformUserId: "private-github-id",
      username: "private-user",
      displayName: "Private Human",
      joinedAt: "2026-06-11T00:00:00.000Z",
    };
    const prompt = await new ContextCompiler(
      config.paths.configDirs,
      config.paths.dataDir,
    ).compileOneOff({
      author,
      title: "Overlay Test",
      metadata: "metadata: true",
      deliveryInstructions: "Deliver one test response.",
    });
    assert.match(prompt, /private soul/);
    assert.doesNotMatch(prompt, /public soul/);
    assert.match(prompt, /shared\.md: Private Shared Policy/);

    console.log("config overlay verification passed");
  });
} finally {
  restoreEnv(previousEnv);
}

function saveEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}
