import { request as httpRequest } from "node:http";

import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

async function verifyToolBroker(): Promise<void> {
  const registry = new DeviceRegistry();
  const broker = new ToolBroker(registry);
  await broker.start();
  try {
    await verifyHappyPath(registry, broker);
    await verifyBadToken(registry, broker);
    await verifyDeviceUnavailable(broker);
    await verifyAbortRejects(registry, broker);
    await verifyInvalidCall(registry, broker);
    await verifyRevoke(registry, broker);
  } finally {
    broker.stop();
    registry.closeAll();
  }
  console.log("tool broker verification passed");
}

async function verifyHappyPath(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A desktop that echoes which tool it was asked to run.
  connectEchoDevice(registry, "d-happy", (dispatch) => ({
    id: dispatch.id,
    ok: true,
    output: `ran ${dispatch.tool}`,
  }));
  const controller = new AbortController();
  const lease = broker.lease({
    key: "d-happy",
    signal: controller.signal,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x" },
  });
  assertEqual(response.status, 200, "happy path returns 200");
  const body = asRecord(response.body);
  assertEqual(body?.["ok"], true, "outcome is ok");
  assertEqual(body?.["output"], "ran local_read", "outcome carries the output");
  lease.revoke();
  console.log("ok a call routes to the device and returns its outcome");
}

async function verifyBadToken(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  connectEchoDevice(registry, "d-token", okEcho);
  const lease = broker.lease({
    key: "d-token",
    signal: new AbortController().signal,
  });
  const response = await postCall(lease.ticket.url, "not-a-real-token", {
    tool: "local_read",
    params: {},
  });
  assertEqual(response.status, 401, "an unknown broker token is rejected");
  lease.revoke();
  console.log("ok an unknown broker token is rejected");
}

async function verifyDeviceUnavailable(broker: ToolBroker): Promise<void> {
  // Lease a turn for a device that never connected.
  const lease = broker.lease({
    key: "d-ghost",
    signal: new AbortController().signal,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x" },
  });
  assertEqual(
    response.status,
    503,
    "a call to an unconnected device returns 503",
  );
  lease.revoke();
  console.log("ok a call to an unconnected device returns 503");
}

async function verifyAbortRejects(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A silent device that receives the dispatch but never answers. Capture its
  // SSE writes so we can confirm the abort propagates as a tool_cancel.
  const writes: string[] = [];
  registry.connect({
    key: "d-silent",
    deviceId: "d-silent",
    identityId: "i",
    write: (chunk) => writes.push(chunk),
    end: () => {},
  });
  const controller = new AbortController();
  const lease = broker.lease({
    key: "d-silent",
    signal: controller.signal,
  });
  const pending = postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_bash",
    params: { command: "sleep" },
  });
  // Abort the turn while the call is in flight.
  setTimeout(() => controller.abort(), 50);
  const response = await pending;
  assertEqual(
    response.status,
    504,
    "an aborted call fails the loopback request",
  );
  assert(
    writes.some((chunk) => chunk.includes("event: tool_cancel")),
    "an aborted call tells the still-connected device to cancel",
  );
  lease.revoke();
  console.log("ok aborting a turn rejects its in-flight call and cancels it");
}

async function verifyInvalidCall(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  connectEchoDevice(registry, "d-invalid", okEcho);
  const lease = broker.lease({
    key: "d-invalid",
    signal: new AbortController().signal,
  });
  const unknownTool = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "rm_minus_rf",
    params: {},
  });
  assertEqual(unknownTool.status, 400, "an unknown tool name is rejected");
  // A proxied tool carrying the wrong params shape is rejected at the broker
  // boundary too, not forwarded to the device as opaque JSON.
  const badParams = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: 42 },
  });
  assertEqual(badParams.status, 400, "invalid params for a tool are rejected");
  lease.revoke();
  console.log("ok a call with an unproxied tool or bad params is rejected");
}

async function verifyRevoke(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  connectEchoDevice(registry, "d-revoke", okEcho);
  const lease = broker.lease({
    key: "d-revoke",
    signal: new AbortController().signal,
  });
  lease.revoke();
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: {},
  });
  assertEqual(response.status, 401, "a revoked token no longer routes");
  console.log("ok a revoked lease token stops working");
}

type EchoDispatch = { id: string; tool: string };
type EchoResult = { id: string; ok: boolean; output: string };

function okEcho(dispatch: EchoDispatch): EchoResult {
  return { id: dispatch.id, ok: true, output: `ran ${dispatch.tool}` };
}

// Registers a device whose SSE writes are parsed for tool calls; for each, it
// settles the matching result on the next microtask, standing in for a real
// desktop on the other end of the link.
function connectEchoDevice(
  registry: DeviceRegistry,
  key: string,
  respond: (dispatch: EchoDispatch) => EchoResult,
): void {
  registry.connect({
    key,
    deviceId: key,
    identityId: "i",
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      if (!match || match[1] === undefined) return;
      const dispatch: unknown = JSON.parse(match[1]);
      const record = asRecord(dispatch);
      const id = record?.["id"];
      const tool = record?.["tool"];
      if (typeof id !== "string" || typeof tool !== "string") return;
      queueMicrotask(() => {
        registry.settleResult(key, respond({ id, tool }));
      });
    },
    end: () => {},
  });
}

type HttpResult = { status: number; body: unknown };

function postCall(
  baseUrl: string,
  token: string,
  body: unknown,
): Promise<HttpResult> {
  return new Promise((resolvePost, rejectPost) => {
    const target = new URL("/call", baseUrl);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolvePost({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", (error) => rejectPost(error));
    req.end(payload);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return { ...value };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

function assert(condition: unknown, label: string): asserts condition {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

await verifyToolBroker();
