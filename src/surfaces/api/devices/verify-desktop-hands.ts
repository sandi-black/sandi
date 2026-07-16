import { assert, assertEqual } from "@/lib/verification/harness";
import { BrokerDesktopHands } from "@/surfaces/api/devices/desktop-hands";
import {
  DeviceRegistry,
  DeviceUnavailableError,
} from "@/surfaces/api/devices/device-registry";
import { ToolDispatchEnvelopeSchema } from "@/surfaces/api/devices/protocol";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

async function verifyDesktopHands(): Promise<void> {
  verifyKeyForIdentity();
  verifyDesktopResolution();
  await verifyBoundedBackpressure();
  await verifyAuthorizationRevocation();
  await verifyLeaseForIdentity();
  console.log("desktop hands verification passed");
}

async function verifyBoundedBackpressure(): Promise<void> {
  const registry = new DeviceRegistry();
  const writes: string[] = [];
  let drain: (() => void) | undefined;
  const link = registry.connect({
    key: "key-slow",
    deviceId: "Grace's slow desktop",
    identityId: "grace",
    write: (chunk) => {
      writes.push(chunk);
      return false;
    },
    end: () => {},
    onDrain: (listener) => {
      drain = listener;
      return () => {};
    },
  });
  try {
    const first = registry.dispatch({
      key: "key-slow",
      call: { tool: "local_read", params: { path: "notes.txt" } },
    });
    await assertRejects(
      registry.dispatch({
        key: "key-slow",
        call: { tool: "local_read", params: { path: "more.txt" } },
      }),
      DeviceUnavailableError,
      "a backpressured link rejects new work",
    );
    assertEqual(writes.length, 1, "only the accepted event is buffered");
    const data = writes[0]
      ?.split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    const dispatch = ToolDispatchEnvelopeSchema.parse(JSON.parse(data ?? ""));
    assert(
      registry.settleResult("key-slow", {
        id: dispatch.id,
        ok: true,
        content: [{ type: "text", text: "done" }],
      }),
      "the first backpressured write was accepted and can settle",
    );
    await first;
    drain?.();
  } finally {
    link.close();
  }
  console.log("ok slow device links stop accepting work until drain");
}

async function verifyAuthorizationRevocation(): Promise<void> {
  const registry = new DeviceRegistry();
  let ended = false;
  registry.connect({
    key: "token-hash",
    deviceId: "Ada's laptop",
    identityId: "ada",
    write: () => true,
    end: () => {
      ended = true;
    },
  });
  registry.retainAuthorizedTokens([]);
  assert(ended, "revoking a token closes its established device link");
  assertEqual(
    registry.keyForIdentity("ada"),
    undefined,
    "a revoked link cannot receive another surface's work",
  );

  registry.connect({
    key: "stale-token",
    deviceId: "Ada's laptop",
    identityId: "ada",
    write: () => true,
    end: () => {},
    isAuthorized: async () => false,
  });
  await assertRejects(
    registry.dispatch({
      key: "stale-token",
      call: { tool: "local_read", params: { path: "notes.txt" } },
    }),
    DeviceUnavailableError,
    "dispatch revalidates authorization before a local side effect",
  );
  assertEqual(
    registry.isConnected("stale-token"),
    false,
    "a failed authorization check tears down the stale link",
  );
  console.log("ok token revocation invalidates existing desktop authority");
}

async function assertRejects(
  promise: Promise<unknown>,
  errorType: new () => Error,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof errorType, message);
    return;
  }
  throw new Error(message);
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
