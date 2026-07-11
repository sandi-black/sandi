import type { LocalToolBroker } from "@/lib/provider/pi-cli-client";

export type DesktopFileDelivery = {
  attachment: {
    name: string;
    mimeType: string;
    size: number;
    dataBase64: string;
  };
  content?: string;
};

// A per-turn handle on a human's connected desktop. `ticket` is the loopback
// broker coordinate the pi child uses to route file and shell tool calls to that
// desktop; `revoke` drops it once the turn ends so the token never outlives the
// turn that minted it.
export type DesktopHandsLease = {
  ticket: LocalToolBroker;
  revoke(): void;
};

// The capability of reaching a human's desktop for hands-local execution,
// expressed as a core interface so any surface can depend on it without
// importing the device registry and tool broker that implement it. The api
// surface owns those (a desktop pairs and holds its link there); this interface
// lets a turn that originated on any other surface lease the same desktop by
// identity.
export interface DesktopHands {
  // Leases hands on the desktop belonging to `identityId`, or returns undefined
  // when that human has no desktop holding a link. The turn then runs with
  // server hands only rather than reaching a machine that is not the caller's.
  leaseForIdentity(input: {
    identityId: string;
    signal: AbortSignal;
    turnId?: string;
    deliverFile?: (delivery: DesktopFileDelivery) => Promise<void>;
  }): DesktopHandsLease | undefined;
}

// Leases desktop hands for a turn whose human is `identityId`. Returns undefined
// when the human is unmapped (no identity) or no desktop-hands capability is
// wired (a standalone single-surface process), so the turn runs with server
// hands only. A missing abort signal is defaulted to a never-aborting one: a
// surface like Discord has no client socket to abort on, so the turn's own
// finally revokes the lease and the broker backstops a stalled call.
export function leaseDesktopHands(input: {
  hands: DesktopHands | undefined;
  identityId: string | undefined;
  signal?: AbortSignal | undefined;
  deliverFile?: (delivery: DesktopFileDelivery) => Promise<void>;
}): DesktopHandsLease | undefined {
  if (!input.identityId || !input.hands) return undefined;
  return input.hands.leaseForIdentity({
    identityId: input.identityId,
    signal: input.signal ?? new AbortController().signal,
    ...(input.deliverFile !== undefined
      ? { deliverFile: input.deliverFile }
      : {}),
  });
}
