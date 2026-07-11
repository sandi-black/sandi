import assert from "node:assert/strict";

import {
  type DesktopFileDelivery,
  type DesktopHands,
  type DesktopHandsLease,
  leaseDesktopHands,
} from "@/lib/provider/desktop-hands";
import type { LocalToolBroker } from "@/lib/provider/pi-cli-client";

const ticket: LocalToolBroker = { url: "http://127.0.0.1:7", token: "ticket" };

type LeaseRecord = {
  identities: string[];
  signals: (AbortSignal | undefined)[];
  deliveries: (
    | ((delivery: DesktopFileDelivery) => Promise<void>)
    | undefined
  )[];
};

function newRecord(): LeaseRecord {
  return { identities: [], signals: [], deliveries: [] };
}

function handsThatLease(record: LeaseRecord): DesktopHands {
  return {
    leaseForIdentity(input): DesktopHandsLease {
      record.identities.push(input.identityId);
      record.signals.push(input.signal);
      record.deliveries.push(input.deliverFile);
      return { ticket, revoke() {} };
    },
  };
}

// An unmapped human (no identity) never reaches for a desktop, even when the
// capability is wired: the turn runs with server hands only.
{
  const record = newRecord();
  const lease = leaseDesktopHands({
    hands: handsThatLease(record),
    identityId: undefined,
  });
  assert.equal(lease, undefined, "unmapped human must not lease");
  assert.equal(record.identities.length, 0, "no lease attempt for no identity");
}

// A standalone single-surface process has no desktop-hands capability wired, so
// even a mapped human leases nothing.
{
  const lease = leaseDesktopHands({
    hands: undefined,
    identityId: "jess-human",
  });
  assert.equal(lease, undefined, "no capability means no lease");
}

// A mapped human with the capability wired leases their own desktop and gets the
// loopback ticket back.
{
  const record = newRecord();
  const controller = new AbortController();
  const lease = leaseDesktopHands({
    hands: handsThatLease(record),
    identityId: "jess-human",
    signal: controller.signal,
  });
  assert.equal(record.identities[0], "jess-human", "leases the caller");
  assert.equal(lease?.ticket.token, ticket.token, "returns the lease ticket");
  assert.equal(record.signals[0], controller.signal, "forwards the signal");
  const deliverFile = async (): Promise<void> => {};
  leaseDesktopHands({
    hands: handsThatLease(record),
    identityId: "jess-human",
    deliverFile,
  });
  assert.equal(
    record.deliveries[1],
    deliverFile,
    "forwards the surface-bound file delivery callback",
  );
}

// A surface with no client socket to abort on (Discord) passes no signal; the
// helper binds a real, never-aborting AbortSignal so the broker still receives a
// well-formed lease request rather than undefined.
{
  const record = newRecord();
  leaseDesktopHands({
    hands: handsThatLease(record),
    identityId: "jess-human",
  });
  const signal = record.signals[0];
  assert.ok(signal instanceof AbortSignal, "defaults a missing signal");
  assert.equal(signal.aborted, false, "the default signal is not pre-aborted");
}

console.log("desktop-hands lease verification passed");
