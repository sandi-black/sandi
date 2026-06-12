export type IdentityPlatform = "discord" | "github";

export type DiscordUserIdentity = {
  platform: "discord";
  id?: string;
  username: string;
  displayName?: string;
};

export type GitHubUserIdentity = {
  platform: "github";
  login: string;
  id?: string;
  displayName?: string;
};

export type PlatformUserIdentity = DiscordUserIdentity | GitHubUserIdentity;

export type HumanIdentityConfig = {
  version: 1;
  humans: HumanIdentityRecord[];
};

export type HumanIdentityRecord = {
  id: string;
  displayName: string;
  platforms: {
    discord?:
      | {
          id?: string | undefined;
          username: string;
        }
      | undefined;
    github?:
      | {
          id?: string | undefined;
          login: string;
        }
      | undefined;
  };
};

export function platformIdentityKey(identity: PlatformUserIdentity): string {
  if (identity.platform === "discord") {
    return identity.id ?? identity.username;
  }
  return identity.id ?? identity.login;
}

export function platformMemoryRef(identity: PlatformUserIdentity): string {
  return `${identity.platform}/${platformIdentityKey(identity)}`;
}

export function participantMemoryRef(participant: {
  platform: IdentityPlatform;
  platformUserId: string;
}): string {
  return `${participant.platform}/${participant.platformUserId}`;
}

export function discordIdentity(input: {
  id?: string;
  username: string;
  displayName?: string;
}): DiscordUserIdentity {
  const identity: DiscordUserIdentity = {
    platform: "discord",
    username: input.username,
  };
  if (input.id) identity.id = input.id;
  if (input.displayName) identity.displayName = input.displayName;
  return identity;
}
