import { readEnv } from "@/lib/config/env";
import { loadHumanIdentities } from "@/lib/identity/resolver";
import {
  InvalidApiSegmentError,
  requireApiSegment,
} from "@/surfaces/api/api/conversations";
import { mintApiToken } from "@/surfaces/api/auth/tokens";
import { loadApiAppConfig } from "@/surfaces/api/config";

await main();

async function main(): Promise<void> {
  const config = loadApiAppConfig();
  const args = parseArgs(process.argv.slice(2));

  const rawIdentityId =
    args.identityId ?? readEnv(["SANDI_API_ENROLL_IDENTITY"]);
  const rawDeviceId = args.deviceId ?? readEnv(["SANDI_API_ENROLL_DEVICE"]);
  const rawLabel = args.label ?? readEnv(["SANDI_API_ENROLL_LABEL"]);

  if (!rawIdentityId || !rawDeviceId || !rawLabel) {
    fail(
      "Usage: tsx src/surfaces/api/auth/enroll.ts --identity <identityId> --device <deviceId> --label <label>",
    );
  }

  const identityId = parseSegment(rawIdentityId, "identityId");
  const deviceId = parseSegment(rawDeviceId, "deviceId");
  const label = rawLabel.trim();
  if (label.length === 0 || label.length > 200) {
    fail("Device label must contain 1-200 characters.");
  }

  const identities = await loadHumanIdentities(config.paths.configDirs);
  const human = identities.humans.find((item) => item.id === identityId);
  if (!human) {
    fail(
      `Identity "${identityId}" was not found in humans.json. Enroll a token only for an existing human identity.`,
    );
  }

  const rawToken = await mintApiToken({
    tokensPath: config.api.tokensPath,
    identityId,
    deviceId,
    label,
  });

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

function parseSegment(value: string, name: "identityId" | "deviceId"): string {
  try {
    return requireApiSegment(value, name);
  } catch (error) {
    if (error instanceof InvalidApiSegmentError) {
      fail(`${name} is not a valid API identifier: ${error.message}`);
    }
    throw error;
  }
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
