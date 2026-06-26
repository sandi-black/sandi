import { findHumanIdentityByPlatformId } from "@/lib/identity/resolver";
import type { HumanIdentityConfig } from "@/lib/identity/types";
import { createPairing } from "@/lib/pairing/pairing-store";

export type DeviceCodeResult =
  | { ok: true; identityId: string; display: string }
  | { ok: false };

/**
 * Issues a device pairing code for the Discord user, if they map to a known
 * household identity. This is the testable core of the `/sandi auth` command,
 * separated from the interaction reply: resolution is auth-grade (immutable
 * Discord account id only), and on success a code is written to the shared
 * pairings path for the API process to redeem. Returns ok=false for an
 * unrecognized user (or one configured without an immutable id), so the caller
 * declines without issuing anything.
 */
export async function issueDeviceCode(input: {
  identities: HumanIdentityConfig;
  pairingsPath: string;
  discordUserId: string;
}): Promise<DeviceCodeResult> {
  const identity = findHumanIdentityByPlatformId({
    identities: input.identities,
    platform: "discord",
    platformUserId: input.discordUserId,
  });
  if (!identity) return { ok: false };
  const pairing = await createPairing({
    path: input.pairingsPath,
    identityId: identity.id,
  });
  return { ok: true, identityId: identity.id, display: pairing.display };
}
