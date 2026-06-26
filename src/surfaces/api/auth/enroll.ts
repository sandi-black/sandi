import { randomBytes } from "node:crypto";

import { readEnv } from "@/lib/config/env";
import { loadHumanIdentities } from "@/lib/identity/resolver";
import { chmodPrivateFile } from "@/lib/state/private-files";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";
import { loadApiAppConfig } from "@/surfaces/api/config";
import {
  type ApiTokenEntry,
  type ApiTokensFile,
  hashApiToken,
  loadApiTokens,
} from "@/surfaces/api/auth/tokens";

const TOKEN_BYTES = 32;

await main();

async function main(): Promise<void> {
  const config = loadApiAppConfig();
  const args = parseArgs(process.argv.slice(2));

  const identityId = args.identityId ?? readEnv(["SANDI_API_ENROLL_IDENTITY"]);
  const deviceId = args.deviceId ?? readEnv(["SANDI_API_ENROLL_DEVICE"]);
  const label = args.label ?? readEnv(["SANDI_API_ENROLL_LABEL"]);

  if (!identityId || !deviceId || !label) {
    fail(
      "Usage: tsx src/surfaces/api/auth/enroll.ts --identity <identityId> --device <deviceId> --label <label>",
    );
  }

  const identities = await loadHumanIdentities(config.paths.configDirs);
  const human = identities.humans.find((item) => item.id === identityId);
  if (!human) {
    fail(
      `Identity "${identityId}" was not found in humans.json. Enroll a token only for an existing human identity.`,
    );
  }

  const rawToken = randomBytes(TOKEN_BYTES).toString("hex");
  const entry: ApiTokenEntry = {
    tokenSha256: hashApiToken(rawToken),
    identityId,
    deviceId,
    label,
  };

  await appendTokenEntry(config.api.tokensPath, entry);

  console.log("Stored a new API token entry.");
  console.log(`  identityId: ${identityId}`);
  console.log(`  deviceId:   ${deviceId}`);
  console.log(`  label:      ${label}`);
  console.log(`  tokensPath: ${config.api.tokensPath}`);
  console.log("");
  console.log("Bearer token (store this now, it will not be shown again):");
  console.log("");
  console.log(`  ${rawToken}`);
  console.log("");
}

async function appendTokenEntry(
  tokensPath: string,
  entry: ApiTokenEntry,
): Promise<void> {
  await withManagedWrite(tokensPath, async () => {
    const current = await loadApiTokens(tokensPath);
    const next = {
      version: 1,
      tokens: [...current.tokens, entry],
    } satisfies ApiTokensFile;
    await atomicWriteInPlace(tokensPath, `${JSON.stringify(next, null, 2)}\n`);
    await chmodPrivateFile(tokensPath);
  });
}

type ParsedArgs = {
  identityId?: string;
  deviceId?: string;
  label?: string;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--identity" && value) {
      parsed.identityId = value;
      index += 1;
    } else if (flag === "--device" && value) {
      parsed.deviceId = value;
      index += 1;
    } else if (flag === "--label" && value) {
      parsed.label = value;
      index += 1;
    }
  }
  return parsed;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
