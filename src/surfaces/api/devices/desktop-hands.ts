import type {
  DesktopHands,
  DesktopHandsLease,
} from "@/lib/provider/desktop-hands";
import type { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import type { ToolBroker } from "@/surfaces/api/devices/tool-broker";

// Implements the core DesktopHands capability over the shared device registry
// and tool broker. A turn from any surface leases the desktop belonging to a
// human identity: the registry resolves that identity to a live link's routing
// key, and the broker mints a per-turn ticket bound to that key and the turn's
// abort signal. The api surface's own turns do not go through here; they already
// hold the device token and lease by its hash directly.
export class BrokerDesktopHands implements DesktopHands {
  readonly #devices: DeviceRegistry;
  readonly #broker: ToolBroker;

  constructor(devices: DeviceRegistry, broker: ToolBroker) {
    this.#devices = devices;
    this.#broker = broker;
  }

  leaseForIdentity(input: {
    identityId: string;
    signal: AbortSignal;
    turnId?: string;
  }): DesktopHandsLease | undefined {
    const key = this.#devices.keyForIdentity(input.identityId);
    if (!key) return undefined;
    const lease = this.#broker.lease({
      key,
      signal: input.signal,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    });
    return { ticket: lease.ticket, revoke: lease.revoke };
  }
}
