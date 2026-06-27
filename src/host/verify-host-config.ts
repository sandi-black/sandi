import { loadHostConfig } from "@/host/config";

// Surface gating env that the host keys off. Cleared before each scenario so a
// developer's own .env (loaded by dotenv at import) cannot leak a token into a
// case that means to run without one.
const GATING_ENV = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "SANDI_API_ENABLED",
  "SANDI_GITHUB_ENABLED",
  "SANDI_ENABLE_GITHUB",
];

function verifyHostConfig(): void {
  verifyApiOnByDefault();
  verifyDiscordGatedOnToken();
  verifyGithubGatedOnFlag();
  verifyApiCanBeDisabled();
  verifyAllSurfacesDisabledThrows();
  verifyEverySurfaceSharesOnePiConfig();
  console.log("host config verification passed");
}

function verifyApiOnByDefault(): void {
  withEnv({}, () => {
    const config = loadHostConfig();
    assertEqual(config.surfaces.api, true, "api is on by default");
    assertEqual(
      config.surfaces.discord,
      false,
      "discord is off without a bot token",
    );
    assertEqual(
      config.surfaces.github,
      false,
      "github is off without an enable flag",
    );
    assertEqual(config.discord, undefined, "no discord config without a token");
    assertEqual(config.github, undefined, "no github config without the flag");
  });
}

function verifyDiscordGatedOnToken(): void {
  withEnv(
    {
      DISCORD_BOT_TOKEN: "token",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
    },
    () => {
      const config = loadHostConfig();
      assertEqual(
        config.surfaces.discord,
        true,
        "discord turns on when a bot token is present",
      );
      assert(config.discord !== undefined, "discord config is built");
      assertEqual(
        config.discord?.discord.token,
        "token",
        "discord config carries the token",
      );
    },
  );
}

function verifyGithubGatedOnFlag(): void {
  withEnv({ SANDI_GITHUB_ENABLED: "true" }, () => {
    const config = loadHostConfig();
    assertEqual(
      config.surfaces.github,
      true,
      "github turns on with the enable flag",
    );
    assert(config.github !== undefined, "github config is built");
  });
}

function verifyApiCanBeDisabled(): void {
  withEnv(
    {
      SANDI_API_ENABLED: "false",
      DISCORD_BOT_TOKEN: "token",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
    },
    () => {
      const config = loadHostConfig();
      assertEqual(
        config.surfaces.api,
        false,
        "api can be turned off explicitly",
      );
      assertEqual(
        config.surfaces.discord,
        true,
        "another surface still runs with the api off",
      );
    },
  );
}

function verifyAllSurfacesDisabledThrows(): void {
  withEnv({ SANDI_API_ENABLED: "false" }, () => {
    let threw = false;
    try {
      loadHostConfig();
    } catch {
      threw = true;
    }
    assertEqual(threw, true, "loading with no enabled surface fails closed");
  });
}

function verifyEverySurfaceSharesOnePiConfig(): void {
  withEnv(
    {
      DISCORD_BOT_TOKEN: "token",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
      SANDI_GITHUB_ENABLED: "true",
    },
    () => {
      const config = loadHostConfig();
      // One provider serves every surface, so each surface config must reference
      // the exact same augmented pi config (the one carrying the hands-local
      // extensions) rather than a separately built copy.
      assert(
        config.discord?.pi === config.api.pi,
        "discord shares the api pi config",
      );
      assert(
        config.github?.pi === config.api.pi,
        "github shares the api pi config",
      );
      assert(
        config.api.pi.extensionPaths.some((path) =>
          path.includes("local-exec-tools"),
        ),
        "the shared pi config loads the hands-local proxy extension",
      );
    },
  );
}

function withEnv(overrides: Record<string, string>, run: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const name of GATING_ENV) {
    snapshot.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of snapshot) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function assert(condition: boolean, label: string): void {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

verifyHostConfig();
