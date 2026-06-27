import { BrokerDesktopHands } from "@/surfaces/api/devices/desktop-hands";
import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

async function verifyDesktopHands(): Promise<void> {
  verifyKeyForIdentity();
  await verifyLeaseForIdentity();
  console.log("desktop hands verification passed");
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

function assert(condition: boolean, label: string): void {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

await verifyDesktopHands();
