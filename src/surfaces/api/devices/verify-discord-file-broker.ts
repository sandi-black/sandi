import { request as httpRequest } from "node:http";

import { assert, assertEqual } from "@/lib/verification/harness";
import {
  type DeviceConnectionHandle,
  DeviceRegistry,
} from "@/surfaces/api/devices/device-registry";
import type { DeviceResult } from "@/surfaces/api/devices/protocol";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

const ATTACHMENT = {
  name: "hopper.png",
  mimeType: "image/png",
  size: 8,
  dataBase64: "iVBORw0KGgo=",
};

export async function verifyDiscordFileBroker(): Promise<void> {
  const registry = new DeviceRegistry();
  const broker = new ToolBroker(registry);
  await broker.start();
  try {
    connectTransferDevice(registry, "grace-desktop", "grace");
    connectTransferDevice(registry, "ada-desktop", "ada");
    const deliveries: unknown[] = [];
    const lease = broker.lease({
      key: "grace-desktop",
      signal: new AbortController().signal,
      deliverFile: async (delivery) => {
        deliveries.push(delivery);
      },
    });
    const sent = await post(lease.ticket.url, lease.ticket.token, {
      path: "plot.png",
      content: "Grace's compiler plot",
    });
    assertEqual(sent.status, 200, "an authorized Discord transfer succeeds");
    assertEqual(deliveries.length, 1, "the Discord callback runs exactly once");
    assert(
      JSON.stringify(deliveries[0]).includes("Grace's compiler plot"),
      "the callback receives the accompanying content",
    );
    const invalidMetadata = await post(lease.ticket.url, lease.ticket.token, {
      path: "plot.png",
      name: "../plot.png",
    });
    assertEqual(
      invalidMetadata.status,
      400,
      "unsafe attachment metadata is rejected before desktop dispatch",
    );

    const crossed = await post(lease.ticket.url, lease.ticket.token, {
      path: "secret.txt",
      desktop: "ada-desktop",
    });
    assertEqual(
      crossed.status,
      422,
      "a transfer cannot select another identity's desktop",
    );
    lease.revoke();
    const stale = await post(lease.ticket.url, lease.ticket.token, {
      path: "plot.png",
    });
    assertEqual(
      stale.status,
      401,
      "a revoked lease cannot transfer another file",
    );

    const noDeliveryLease = broker.lease({
      key: "grace-desktop",
      signal: new AbortController().signal,
    });
    const unavailable = await post(
      noDeliveryLease.ticket.url,
      noDeliveryLease.ticket.token,
      { path: "plot.png" },
    );
    assertEqual(
      unavailable.status,
      409,
      "a non-Discord lease cannot invoke Discord delivery",
    );
    noDeliveryLease.revoke();

    const failingLease = broker.lease({
      key: "grace-desktop",
      signal: new AbortController().signal,
      deliverFile: async () => {
        throw new Error("simulated Discord upload failure");
      },
    });
    const failedUpload = await post(
      failingLease.ticket.url,
      failingLease.ticket.token,
      { path: "plot.png" },
    );
    assertEqual(
      failedUpload.status,
      502,
      "Discord upload failure is reported to the tool caller",
    );
    failingLease.revoke();

    const dropped = connectTransferDevice(
      registry,
      "dropped-desktop",
      "dorothy",
    );
    const droppedLease = broker.lease({
      key: "dropped-desktop",
      signal: new AbortController().signal,
      deliverFile: async () => {},
    });
    dropped.close();
    const disconnected = await post(
      droppedLease.ticket.url,
      droppedLease.ticket.token,
      { path: "plot.png" },
    );
    assertEqual(
      disconnected.status,
      503,
      "a desktop that disconnects after lease cannot transfer a file",
    );
    droppedLease.revoke();

    const cancelled = new AbortController();
    const cancelledLease = broker.lease({
      key: "grace-desktop",
      signal: cancelled.signal,
      deliverFile: async () => {},
    });
    cancelled.abort();
    const afterCancel = await post(
      cancelledLease.ticket.url,
      cancelledLease.ticket.token,
      { path: "plot.png" },
    );
    assertEqual(afterCancel.status, 401, "a cancelled turn rejects transfer");
    cancelledLease.revoke();
    console.log(
      "ok Discord file broker binds transfers to the turn, identity, and upload callback",
    );
  } finally {
    broker.stop();
    registry.closeAll();
  }
}

function connectTransferDevice(
  registry: DeviceRegistry,
  key: string,
  identityId: string,
): DeviceConnectionHandle {
  return registry.connect({
    key,
    deviceId: key,
    identityId,
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      if (!match?.[1]) return true;
      const raw: unknown = JSON.parse(match[1]);
      if (!raw || typeof raw !== "object" || !("id" in raw)) return true;
      const id = raw.id;
      if (typeof id !== "string") return true;
      const result: DeviceResult = {
        id,
        ok: true,
        content: [{ type: "text", text: "prepared file" }],
        attachment: ATTACHMENT,
      };
      queueMicrotask(() => registry.settleResult(key, result));
      return true;
    },
    end: () => {},
  });
}

function post(baseUrl: string, token: string, body: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = httpRequest(
      new URL("/discord-file", baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}
