import { randomBytes } from "node:crypto";

import type { HumanIdentityStore } from "@/lib/identity/resolver";
import {
  consumePairing,
  normalizePairingCode,
} from "@/lib/pairing/pairing-store";
import { isRecord } from "@/lib/type-guards";
import {
  InvalidApiSegmentError,
  requireApiSegment,
} from "@/surfaces/api/api/conversations";
import { apiParticipantFromHuman } from "@/surfaces/api/auth/participant";
import { mintApiToken } from "@/surfaces/api/auth/tokens";

const MAX_DEVICE_LABEL_LENGTH = 200;

export type PairingRedeemResult =
  | {
      ok: true;
      identityId: string;
      deviceId: string;
      label: string;
      token: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Redeems a pairing code for a per-device bearer token. This is the enrollment
 * domain logic, kept apart from the HTTP layer: the caller hands in the parsed
 * JSON body and the stores, and gets back either a minted token or a status and
 * error code to return. Validation happens before the code is consumed where it
 * can (a bad device id should not burn the code), and the bound identity is
 * re-resolved against the current `humans.json` so a removed member cannot mint.
 * The raw token is in the success result and must never be logged.
 */
export async function redeemPairing(input: {
  body: unknown;
  pairingsPath: string;
  tokensPath: string;
  identities: HumanIdentityStore;
  now?: number;
}): Promise<PairingRedeemResult> {
  const parsed = parsePairBody(input.body);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  const code = normalizePairingCode(parsed.code);
  if (!code) return { ok: false, status: 401, error: "invalid_code" };

  // Validate the client-controlled device id before consuming the code, so a
  // client bug that sends a bad device id lets the user retry the same code
  // rather than having to run `/sandi auth` again.
  let deviceId: string;
  if (parsed.deviceId !== undefined) {
    try {
      deviceId = requireApiSegment(parsed.deviceId, "deviceId");
    } catch (error) {
      if (error instanceof InvalidApiSegmentError) {
        return { ok: false, status: 400, error: "invalid_device_id" };
      }
      throw error;
    }
  } else {
    deviceId = generateDeviceId();
  }

  const consumed = await consumePairing({
    path: input.pairingsPath,
    code,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!consumed) return { ok: false, status: 401, error: "invalid_code" };

  // The code bound an identity at issue time. Re-resolve it now: a member
  // removed or unmapped between issue and redemption gets a 403 and no token.
  const identities = await input.identities.load();
  const human = identities.humans.find(
    (item) => item.id === consumed.identityId,
  );
  const participant = human ? apiParticipantFromHuman(human) : undefined;
  if (!participant) {
    return { ok: false, status: 403, error: "identity_unmapped" };
  }

  const label = parsed.label ?? `Device ${deviceId}`;
  const token = await mintApiToken({
    tokensPath: input.tokensPath,
    identityId: consumed.identityId,
    deviceId,
    label,
  });
  return { ok: true, identityId: consumed.identityId, deviceId, label, token };
}

// A short, segment-safe device id (matches the conversation segment alphabet) so
// distinct enrolled devices for one identity never collide in the canonical id.
function generateDeviceId(): string {
  return `device-${randomBytes(4).toString("hex")}`;
}

type ParsedPairBody =
  | { ok: true; code: string; deviceId?: string; label?: string }
  | { ok: false; error: string };

function parsePairBody(value: unknown): ParsedPairBody {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_body" };
  }
  const record = value;
  const code = record["code"];
  if (typeof code !== "string" || code.trim().length === 0) {
    return { ok: false, error: "invalid_code" };
  }
  const rawDeviceId = record["deviceId"];
  if (rawDeviceId !== undefined && typeof rawDeviceId !== "string") {
    return { ok: false, error: "invalid_device_id" };
  }
  const rawLabel = record["label"];
  if (rawLabel !== undefined && typeof rawLabel !== "string") {
    return { ok: false, error: "invalid_label" };
  }
  const deviceId =
    typeof rawDeviceId === "string" && rawDeviceId.trim().length > 0
      ? rawDeviceId.trim()
      : undefined;
  const label =
    typeof rawLabel === "string" && rawLabel.trim().length > 0
      ? rawLabel.trim().slice(0, MAX_DEVICE_LABEL_LENGTH)
      : undefined;
  return {
    ok: true,
    code,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}
