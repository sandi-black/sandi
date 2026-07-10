import { assert, assertEqual } from "@/lib/verification/harness";
import { BrokerDesktopHands } from "@/surfaces/api/devices/desktop-hands";
import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

async function verifyDesktopHands(): Promise<void> {
  verifyKeyForIdentity();
  verifyDesktopResolution();
  await verifyLeaseForIdentity();
  console.log("desktop hands verification passed");
}

function verifyDesktopResolution(): void {
  const registry = new DeviceRegistry();
  const a = registry.connect({
    key: "key-a",
    deviceId: "Grace's ThinkPad",
    identityId: "grace",
    write: () => true,
    end: () => {},
  });
  const b = registry.connect({
    key: "key-b",
    deviceId: "Hopper Studio",
    identityId: "grace",
    write: () => true,
    end: () => {},
  });
  const c = registry.connect({
    key: "key-c",
    deviceId: "Ada's Desk",
    identityId: "ada",
    write: () => true,
    end: () => {},
  });

  assertEqual(
    registry.identityForKey("key-a"),
    "grace",
    "a live key resolves to its owning identity",
  );
  assertEqual(
    registry.identityForKey("key-missing"),
    undefined,
    "an unknown key resolves to no identity",
  );

  const graceDesktops = registry
    .desktopsForIdentity("grace")
    .map((desktop) => desktop.key)
    .sort();
  assertEqual(
    JSON.stringify(graceDesktops),
    JSON.stringify(["key-a", "key-b"]),
    "an identity sees all of its own connected desktops",
  );
  assertEqual(
    registry.desktopsForIdentity("grace").some((d) => d.key === "key-c"),
    false,
    "an identity never sees another human's desktop",
  );

  // A closed link drops out of both resolutions.
  b.close();
  assertEqual(
    registry.identityForKey("key-b"),
    undefined,
    "a closed key no longer resolves to an identity",
  );
  assertEqual(
    registry.desktopsForIdentity("grace").length,
    1,
    "a closed desktop drops out of the identity's set",
  );

  a.close();
  c.close();
  console.log("ok identityForKey and desktopsForIdentity scope by identity");
}

function verifyKeyForIdentity(): void {
  const registry = new DeviceRegistry();
  const links = [
    registry.connect({
      key: "key-a",
      deviceId: "device-a",
      identityId: "jess",
      write: () => true,
      end: () => {},
    }),
    registry.connect({
      key: "key-b",
      deviceId: "device-b",
      identityId: "sam",
      write: () => true,
      end: () => {},
    }),
  ];

  assertEqual(
    registry.keyForIdentity("jess"),
    "key-a",
    "an identity resolves to its own device link",
  );
  assertEqual(
    registry.keyForIdentity("sam"),
    "key-b",
    "a second identity resolves to its own link, not the first",
  );
  assertEqual(
    registry.keyForIdentity("nobody"),
    undefined,
    "an identity with no link resolves to nothing, never a stranger's machine",
  );

  // A human links a second desktop. The most recently connected one wins.
  const second = registry.connect({
    key: "key-c",
    deviceId: "device-c",
    identityId: "jess",
    write: () => true,
    end: () => {},
  });
  assertEqual(
    registry.keyForIdentity("jess"),
    "key-c",
    "with two desktops linked, the newest one is chosen",
  );

  // Closing the newest falls back to the older live link.
  second.close();
  assertEqual(
    registry.keyForIdentity("jess"),
    "key-a",
    "closing the newest desktop falls back to the older live link",
  );

  for (const link of links) link.close();
  assertEqual(
    registry.keyForIdentity("jess"),
    undefined,
    "with every link closed the identity resolves to nothing again",
  );
}

async function verifyLeaseForIdentity(): Promise<void> {
  const registry = new DeviceRegistry();
  const broker = new ToolBroker(registry);
  await broker.start();
  try {
    const hands = new BrokerDesktopHands(registry, broker);
    const controller = new AbortController();

    assertEqual(
      hands.leaseForIdentity({
        identityId: "jess",
        signal: controller.signal,
      }),
      undefined,
      "no lease is issued for an identity with no connected desktop",
    );

    const link = registry.connect({
      key: "key-a",
      deviceId: "device-a",
      identityId: "jess",
      write: () => true,
      end: () => {},
    });
    try {
      const lease = hands.leaseForIdentity({
        identityId: "jess",
        signal: controller.signal,
      });
      assert(
        lease !== undefined,
        "a lease is issued once the desktop is linked",
      );
      assertEqual(
        lease?.ticket.url,
        broker.url(),
        "the lease points at the loopback broker",
      );
      assert(
        /^[0-9a-f]{64}$/.test(lease?.ticket.token ?? ""),
        "the lease carries a 256-bit hex token",
      );
      lease?.revoke();
    } finally {
      link.close();
    }
  } finally {
    broker.stop();
    registry.closeAll();
  }
}

await verifyDesktopHands();
