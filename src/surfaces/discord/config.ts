import {
  type CoreConfig,
  loadCoreConfig,
  readEnv,
  requireEnv,
} from "@/lib/config/env";

export type DiscordConfig = {
  token: string;
  clientId: string;
  guildId: string;
  forumChannelId?: string;
  forumChannelName: string;
  statusChannelId?: string;
  statusChannelName: string;
};

export type DiscordAppConfig = CoreConfig & {
  discord: DiscordConfig;
};

export function loadDiscordConfig(): DiscordConfig {
  const forumChannelId = readEnv(["SANDI_FORUM_CHANNEL_ID"]);
  const statusChannelId = readEnv(["SANDI_STATUS_CHANNEL_ID"]);
  const config: DiscordConfig = {
    token: requireEnv(["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"]),
    clientId: requireEnv(["DISCORD_CLIENT_ID", "DISCORD_APPLICATION_ID"]),
    guildId: requireEnv(["DISCORD_GUILD_ID"]),
    forumChannelName: readEnv(["SANDI_FORUM_CHANNEL_NAME"]) ?? "sandi",
    statusChannelName: readEnv(["SANDI_STATUS_CHANNEL_NAME"]) ?? "status",
  };
  if (forumChannelId) config.forumChannelId = forumChannelId;
  if (statusChannelId) config.statusChannelId = statusChannelId;
  return config;
}

export function loadDiscordAppConfig(): DiscordAppConfig {
  return {
    ...loadCoreConfig(),
    discord: loadDiscordConfig(),
  };
}
