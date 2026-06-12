import {
  ChannelType,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";

import type { DiscordConfig } from "@/surfaces/discord/config";

export async function findSandiForum(
  client: Client,
  config: DiscordConfig,
): Promise<ForumChannel> {
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await findForumChannel(guild, config);
  if (!channel) {
    throw new Error(
      `Could not find Sandi forum channel. Set SANDI_FORUM_CHANNEL_ID or create a forum named ${config.forumChannelName}.`,
    );
  }
  return channel;
}

async function findForumChannel(
  guild: Guild,
  config: DiscordConfig,
): Promise<ForumChannel | undefined> {
  if (config.forumChannelId) {
    const channel = await guild.channels.fetch(config.forumChannelId);
    return asForumChannel(channel);
  }

  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    const forum = asForumChannel(channel);
    if (forum && forum.name === config.forumChannelName) return forum;
  }
  return undefined;
}

function asForumChannel(
  channel: GuildBasedChannel | null,
): ForumChannel | undefined {
  if (!channel) return undefined;
  if (channel.type !== ChannelType.GuildForum) return undefined;
  return channel;
}
