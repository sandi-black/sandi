import { readEnv } from "@/lib/config/env";
import { type ApiAppConfig, loadApiAppConfig } from "@/surfaces/api/config";
import {
  type DiscordAppConfig,
  loadDiscordConfig,
} from "@/surfaces/discord/config";
import {
  type GitHubAppConfig,
  loadGitHubConfig,
} from "@/surfaces/github/config";

// The merged host runs every configured surface in one process so a turn from
// any surface shares the same conversation store, provider, and (crucially) the
// same device links. The surfaces are composed from one core config: the
// hands-local pi extensions are loaded for every surface (they self-gate to
// nothing on a turn that did not lease a tool broker), so the single shared
// provider can serve desktop hands to Discord and GitHub turns too.
export type HostConfig = {
  // The full api app config, including the augmented pi config (core extensions
  // plus the hands-local proxy and response-stream extensions). Its `pi` and
  // `paths` are the shared configuration for the whole process.
  api: ApiAppConfig;
  // Present only when each surface is enabled. Both carry the same shared `pi`
  // and `paths` as `api`, so one provider and one data dir back every surface.
  discord?: DiscordAppConfig;
  github?: GitHubAppConfig;
  surfaces: {
    api: boolean;
    discord: boolean;
    github: boolean;
  };
};

// Loads the configuration for every surface the process should run. The api
// surface (the device server that desktops pair to) is on by default because it
// is what makes hands-local execution reachable from any surface; set
// SANDI_API_ENABLED=false to turn it off. Discord starts when a bot token is
// present. GitHub is opt-in via SANDI_GITHUB_ENABLED because its config has no
// required env to key presence off.
export function loadHostConfig(): HostConfig {
  // loadApiAppConfig carries the augmented pi config (it adds the local-exec and
  // response-stream extensions to the core set). Every surface in the host
  // shares this pi config, so those extensions are present for all turns and the
  // single provider can route file/shell work to a connected desktop regardless
  // of which surface the turn came from.
  const api = loadApiAppConfig();

  const apiEnabled = readBooleanEnv(["SANDI_API_ENABLED"], true);
  const discordEnabled = hasDiscordToken();
  const githubEnabled = readBooleanEnv(
    ["SANDI_GITHUB_ENABLED", "SANDI_ENABLE_GITHUB"],
    false,
  );

  if (!apiEnabled && !discordEnabled && !githubEnabled) {
    throw new Error(
      "No surface is enabled. Set DISCORD_BOT_TOKEN for Discord, " +
        "SANDI_GITHUB_ENABLED=true for GitHub, or leave SANDI_API_ENABLED on.",
    );
  }

  const config: HostConfig = {
    api,
    surfaces: {
      api: apiEnabled,
      discord: discordEnabled,
      github: githubEnabled,
    },
  };

  if (discordEnabled) {
    config.discord = {
      pi: api.pi,
      paths: api.paths,
      ...(api.environmentHint !== undefined
        ? { environmentHint: api.environmentHint }
        : {}),
      discord: loadDiscordConfig(),
    };
  }

  if (githubEnabled) {
    config.github = {
      pi: api.pi,
      paths: api.paths,
      ...(api.environmentHint !== undefined
        ? { environmentHint: api.environmentHint }
        : {}),
      github: loadGitHubConfig(),
    };
  }

  return config;
}

function hasDiscordToken(): boolean {
  return readEnv(["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"]) !== undefined;
}

function readBooleanEnv(
  names: readonly string[],
  defaultValue: boolean,
): boolean {
  const value = readEnv(names);
  if (!value) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`${names[0]} must be true or false`);
}
