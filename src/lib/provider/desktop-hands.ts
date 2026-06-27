import type { LocalToolBroker } from "@/lib/provider/pi-cli-client";

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
  }): DesktopHandsLease | undefined;
}
