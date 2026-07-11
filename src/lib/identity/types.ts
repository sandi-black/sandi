import { SURFACE_IDS, type SurfaceId } from "@/lib/surface-context";

// The "api" surface (the desktop hands-local surface) is deliberately not an
// identity platform: it has no platform-native account of its own to bind a
// human identity to (a device pairs to an existing Discord or GitHub
// identity, it does not mint a new one). Deriving from SurfaceId keeps this
// union in step with the surface registry while still excluding "api".
export type IdentityPlatform = Exclude<SurfaceId, "api">;

export const IDENTITY_PLATFORMS: readonly IdentityPlatform[] =
  SURFACE_IDS.filter(
    (surface): surface is IdentityPlatform => surface !== "api",
  );

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
  primaryPlatform?: IdentityPlatform | undefined;
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

// A humans.json account entry, normalized to one shape regardless of
// platform: discord accounts key on `username`, github accounts key on
// `login`, but everything downstream (matching, uniqueness checks) only ever
// needs "the account's immutable id, if any, and its mutable handle".
export type NormalizedPlatformAccount = {
  id?: string | undefined;
  username: string;
};

export type PlatformIdentityDescriptor = {
  // The display name used in duplicate-account error messages.
  label: string;
  readAccount: (
    platforms: HumanIdentityRecord["platforms"],
  ) => NormalizedPlatformAccount | undefined;
};

// The one place a new identity platform gets wired in: reading its account
// out of a HumanIdentityRecord's `platforms` block, normalized to a common
// shape. Identity resolution and duplicate checks dispatch through this table
// instead of hand-rolling a branch per platform, so adding a platform to
// IdentityPlatform means adding one entry here.
export const PLATFORM_IDENTITY_DESCRIPTORS: Record<
  IdentityPlatform,
  PlatformIdentityDescriptor
> = {
  discord: {
    label: "Discord",
    readAccount: (platforms) => platforms.discord,
  },
  github: {
    label: "GitHub",
    readAccount: (platforms) =>
      platforms.github
        ? { id: platforms.github.id, username: platforms.github.login }
        : undefined,
  },
};

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
