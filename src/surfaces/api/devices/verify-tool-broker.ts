import { request as httpRequest } from "node:http";

import { assert, assertEqual } from "@/lib/verification/harness";
import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";

async function verifyToolBroker(): Promise<void> {
  await verifyLifecycle();
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
    await verifyListDesktops(registry, broker);
    await verifyDesktopTargeting(registry, broker);
    await verifyOriginDeviceDefault(registry, broker);
    await verifyAmbiguousDefault(registry, broker);
    await verifyStaleKeyFailover(registry, broker);
    await verifyUnknownDesktop(registry, broker);
    await verifyImagePassthrough(registry, broker);
    await verifyStreamRelay(registry, broker);
    await verifyStreamToGoneDevice(broker);
    await verifyStreamTurnMismatch(registry, broker);
    await verifyAttachmentRelay(registry, broker);
    await verifyAttachmentToGoneDevice(broker);
    await verifyAttachmentTurnMismatch(registry, broker);
  } finally {
    broker.stop();
    registry.closeAll();
  }
  console.log("tool broker verification passed");
}

async function verifyLifecycle(): Promise<void> {
  const broker = new ToolBroker(new DeviceRegistry());
  const first = broker.start();
  const concurrent = broker.start();
  assert(first === concurrent, "concurrent starts share one readiness promise");
  await first;
  assert(broker.url() !== undefined, "start resolves only after URL readiness");
  broker.stop();

  const interrupted = broker.start();
  broker.stop();
  await assertRejects(interrupted, "stopping during start settles its promise");
  await broker.start();
  assert(
    broker.url() !== undefined,
    "a broker can restart after interrupted start",
  );
  broker.stop();
  console.log(
    "ok tool broker start and stop have deterministic lifecycle state",
  );
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
    originDevice: true,
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
  let markDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  registry.connect({
    key: "d-silent",
    deviceId: "d-silent",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      if (chunk.includes("event: tool_call")) markDispatched?.();
      return true;
    },
    end: () => {},
  });
  const controller = new AbortController();
  const lease = broker.lease({
    key: "d-silent",
    signal: controller.signal,
    originDevice: true,
  });
  const pending = postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_bash",
    params: { command: "sleep" },
  });
  // Abort only after the fake desktop observed the call. This barrier makes the
  // cancellation assertion independent of CI scheduling.
  await dispatched;
  controller.abort();
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
  const writes: string[] = [];
  let markDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  registry.connect({
    key: "d-revoke",
    deviceId: "d-revoke",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      if (chunk.includes("event: tool_call")) markDispatched?.();
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "d-revoke",
    signal: new AbortController().signal,
    originDevice: true,
  });
  const pending = postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_bash",
    params: { command: "long-running" },
  });
  const first = await Promise.race([
    dispatched.then(() => ({ type: "dispatch" as const })),
    pending.then((response) => ({ type: "response" as const, response })),
  ]);
  assertEqual(
    first.type,
    "dispatch",
    `revoke fixture must dispatch before settling (${JSON.stringify(first)})`,
  );
  lease.revoke();
  const interrupted = await pending;
  assertEqual(interrupted.status, 504, "revoke settles an in-flight call");
  assert(
    writes.some((chunk) => chunk.includes("event: tool_cancel")),
    "revoke tells the desktop to cancel authorized work",
  );
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: {},
  });
  assertEqual(response.status, 401, "a revoked token no longer routes");
  console.log("ok lease revocation cancels in-flight work and stops new calls");
}

async function assertRejects(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(message);
}

async function verifyListDesktops(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // Two desktops for one human, plus one for another human. The discovery call
  // names only the leasing identity's desktops, with the leased one marked.
  connectEchoDevice(registry, "grace-1", okEcho, "grace");
  connectEchoDevice(registry, "grace-2", okEcho, "grace");
  connectEchoDevice(registry, "ada-1", okEcho, "ada");
  const lease = broker.lease({
    key: "grace-1",
    signal: new AbortController().signal,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_list_desktops",
    params: {},
  });
  assertEqual(response.status, 200, "list_desktops returns 200");
  const body = asRecord(response.body);
  assertEqual(body?.["ok"], true, "list_desktops is an ok outcome");
  const output = body?.["output"];
  const text = typeof output === "string" ? output : "";
  assert(
    text.includes("Connected desktops (2)"),
    "only the leasing identity's desktops are listed",
  );
  assert(text.includes("(current)"), "the leased desktop is marked current");
  assert(
    !text.includes("ada-1"),
    "another human's desktop never appears in the list",
  );
  lease.revoke();
  console.log("ok list_desktops names the identity's own desktops");
}

async function verifyDesktopTargeting(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A turn leased to one desktop can target another desktop of the same
  // identity by selector; the call reaches that desktop, not the leased one.
  // This holds for a file tool, not only the state tools.
  connectEchoDevice(
    registry,
    "hopper-1",
    (dispatch) => ({ id: dispatch.id, ok: true, output: "from hopper-1" }),
    "hopper",
  );
  connectEchoDevice(
    registry,
    "hopper-2",
    (dispatch) => ({ id: dispatch.id, ok: true, output: "from hopper-2" }),
    "hopper",
  );
  const lease = broker.lease({
    key: "hopper-1",
    signal: new AbortController().signal,
  });

  const targeted = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x", desktop: "hopper-2" },
  });
  assertEqual(
    asRecord(targeted.body)?.["output"],
    "from hopper-2",
    "a selector routes any tool to the named desktop of the same identity",
  );
  lease.revoke();
  console.log("ok a desktop selector routes any tool to the named desktop");
}

async function verifyOriginDeviceDefault(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A turn that originated on a desktop runs an unselected call on that desktop
  // even when the human has other desktops connected.
  connectEchoDevice(
    registry,
    "curie-1",
    (dispatch) => ({ id: dispatch.id, ok: true, output: "from curie-1" }),
    "curie",
  );
  connectEchoDevice(
    registry,
    "curie-2",
    (dispatch) => ({ id: dispatch.id, ok: true, output: "from curie-2" }),
    "curie",
  );
  const lease = broker.lease({
    key: "curie-1",
    signal: new AbortController().signal,
    originDevice: true,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x" },
  });
  assertEqual(
    asRecord(response.body)?.["output"],
    "from curie-1",
    "an origin-device turn defaults to its own desktop despite others connected",
  );
  lease.revoke();
  console.log("ok an origin-device turn defaults to the desktop it came from");
}

async function verifyAmbiguousDefault(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A turn not tied to a desktop, with several of the identity's desktops
  // connected and no selector, refuses and asks the model to pick rather than
  // guessing the most recently linked one.
  connectEchoDevice(registry, "noether-1", okEcho, "noether");
  connectEchoDevice(registry, "noether-2", okEcho, "noether");
  const lease = broker.lease({
    key: "noether-1",
    signal: new AbortController().signal,
  });
  const ambiguous = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x" },
  });
  assertEqual(ambiguous.status, 200, "an ambiguous default is a 200 outcome");
  const body = asRecord(ambiguous.body);
  assertEqual(body?.["ok"], false, "an ambiguous default refuses the call");
  const error = body?.["error"];
  assert(
    typeof error === "string" && error.includes("name a desktop"),
    "the refusal asks the model to name a desktop",
  );

  // The same turn proceeds once it names one.
  const picked = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x", desktop: "noether-2" },
  });
  assertEqual(
    asRecord(picked.body)?.["ok"],
    true,
    "naming a desktop resolves the ambiguity",
  );
  lease.revoke();
  console.log(
    "ok an unanchored turn with several desktops asks the model to pick",
  );
}

async function verifyStaleKeyFailover(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // An identity-bound turn whose original desktop dropped and relinked under a
  // new key still resolves an unselected call to the sole live desktop, not the
  // dead lease key. The lease captures the identity while the first link is up.
  const first = registry.connect({
    key: "hopper-1",
    deviceId: "hopper-1",
    identityId: "hopper",
    write: () => true,
    end: () => {},
  });
  const lease = broker.lease({
    key: "hopper-1",
    signal: new AbortController().signal,
  });
  // The original desktop drops its link and the human relinks under a fresh key.
  first.close();
  connectEchoDevice(
    registry,
    "hopper-2",
    (dispatch) => ({ id: dispatch.id, ok: true, output: "from hopper-2" }),
    "hopper",
  );
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_read",
    params: { path: "x" },
  });
  assertEqual(
    asRecord(response.body)?.["output"],
    "from hopper-2",
    "an unselected call resolves to the sole live desktop, not the stale lease key",
  );
  lease.revoke();
  console.log(
    "ok an unanchored turn with one relinked desktop targets the live key",
  );
}

async function verifyUnknownDesktop(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A selector that matches no desktop of the identity (here, another human's)
  // is a refused outcome, not a transport error, so the model sees a tool error.
  connectEchoDevice(registry, "lovelace-1", okEcho, "lovelace");
  connectEchoDevice(registry, "babbage-1", okEcho, "babbage");
  const lease = broker.lease({
    key: "lovelace-1",
    signal: new AbortController().signal,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_screenshot",
    params: { desktop: "babbage-1" },
  });
  assertEqual(
    response.status,
    200,
    "an unknown desktop is still a 200 outcome",
  );
  const body = asRecord(response.body);
  assertEqual(body?.["ok"], false, "an unknown desktop refuses the call");
  const error = body?.["error"];
  assert(
    typeof error === "string" && error.includes("no connected desktop matches"),
    "the refusal names the unmatched selector",
  );
  lease.revoke();
  console.log(
    "ok a selector that crosses identities refuses rather than routes",
  );
}

async function verifyImagePassthrough(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A desktop that answers a screenshot with an image: the broker relays the
  // image alongside the text in its /call reply.
  registry.connect({
    key: "shot",
    deviceId: "shot",
    identityId: "i",
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      if (!match || match[1] === undefined) return true;
      const dispatch = asRecord(JSON.parse(match[1]));
      const id = dispatch?.["id"];
      if (typeof id !== "string") return true;
      queueMicrotask(() => {
        registry.settleResult("shot", {
          id,
          ok: true,
          output: "captured primary monitor",
          image: { mimeType: "image/jpeg", dataBase64: "/9j/4AAQ" },
        });
      });
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "shot",
    signal: new AbortController().signal,
    originDevice: true,
  });
  const response = await postCall(lease.ticket.url, lease.ticket.token, {
    tool: "local_screenshot",
    params: {},
  });
  assertEqual(response.status, 200, "a screenshot returns 200");
  const body = asRecord(response.body);
  const image = asRecord(body?.["image"]);
  assertEqual(
    image?.["mimeType"],
    "image/jpeg",
    "the image mime type rides back to the caller",
  );
  assertEqual(
    image?.["dataBase64"],
    "/9j/4AAQ",
    "the image bytes ride back to the caller",
  );
  lease.revoke();
  console.log("ok a screenshot image relays through the broker reply");
}

async function verifyStreamRelay(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // Capture the device's SSE writes so we can confirm a relayed delta lands as a
  // response_chunk event on its link.
  const writes: string[] = [];
  registry.connect({
    key: "d-stream",
    deviceId: "d-stream",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "d-stream",
    signal: new AbortController().signal,
  });

  const chunk = {
    type: "delta",
    turnId: "turn-1",
    seq: 0,
    channel: "text",
    delta: "hello",
  };
  const ok = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    chunk,
    "/stream",
  );
  assertEqual(ok.status, 202, "a relayed delta is accepted with 202");
  assert(
    writes.some(
      (w) => w.includes("event: response_chunk") && w.includes("hello"),
    ),
    "the delta reaches the device as a response_chunk event",
  );

  // A malformed chunk is rejected at the broker boundary, not relayed.
  const bad = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { type: "delta", turnId: "turn-1", seq: 0, channel: "sideways" },
    "/stream",
  );
  assertEqual(bad.status, 400, "a malformed chunk is rejected");
  lease.revoke();
  console.log("ok a response delta relays to the device as a response_chunk");
}

async function verifyStreamTurnMismatch(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A lease bound to a turn id relays only that turn's deltas; a delta tagged
  // with another turn is rejected so it cannot be attributed to the wrong turn.
  const writes: string[] = [];
  registry.connect({
    key: "d-turn",
    deviceId: "d-turn",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "d-turn",
    signal: new AbortController().signal,
    turnId: "turn-A",
  });

  const wrong = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { type: "delta", turnId: "turn-B", seq: 0, channel: "text", delta: "x" },
    "/stream",
  );
  assertEqual(wrong.status, 409, "a delta for another turn is rejected");
  assert(
    !writes.some((w) => w.includes("response_chunk")),
    "a mismatched delta never reaches the device",
  );

  const right = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { type: "delta", turnId: "turn-A", seq: 0, channel: "text", delta: "ok" },
    "/stream",
  );
  assertEqual(right.status, 202, "a delta for the leased turn is relayed");
  lease.revoke();
  console.log("ok a stream delta must match the leased turn id");
}

async function verifyStreamToGoneDevice(broker: ToolBroker): Promise<void> {
  // A turn leased for a device that never connected: a streamed delta has
  // nowhere to land, so the broker answers 503 and the child stops pushing.
  const lease = broker.lease({
    key: "d-stream-ghost",
    signal: new AbortController().signal,
  });
  const response = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { type: "end", turnId: "turn-1", seq: 1 },
    "/stream",
  );
  assertEqual(response.status, 503, "a delta to an absent device returns 503");
  lease.revoke();
  console.log("ok a delta to an unconnected device returns 503");
}

async function verifyAttachmentRelay(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // Capture the device's SSE writes so we can confirm attach_to_reply's notice
  // lands as a response_attachment event on its link.
  const writes: string[] = [];
  registry.connect({
    key: "d-attach",
    deviceId: "d-attach",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "d-attach",
    signal: new AbortController().signal,
  });

  const attachment = {
    turnId: "turn-1",
    seq: 0,
    path: "C:/Users/hopper/Desktop/plot.png",
    name: "plot.png",
  };
  const ok = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    attachment,
    "/attachment",
  );
  assertEqual(ok.status, 202, "a relayed attachment is accepted with 202");
  assert(
    writes.some(
      (w) => w.includes("event: response_attachment") && w.includes("plot.png"),
    ),
    "the attachment reaches the device as a response_attachment event",
  );

  // A malformed attachment is rejected at the broker boundary, not relayed.
  const bad = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { turnId: "turn-1", seq: 0 },
    "/attachment",
  );
  assertEqual(bad.status, 400, "a malformed attachment is rejected");
  lease.revoke();
  console.log(
    "ok an outbound attachment relays to the device as a response_attachment",
  );
}

async function verifyAttachmentTurnMismatch(
  registry: DeviceRegistry,
  broker: ToolBroker,
): Promise<void> {
  // A lease bound to a turn id relays only that turn's attachments; a notice
  // tagged with another turn is rejected so it cannot be attributed wrongly.
  const writes: string[] = [];
  registry.connect({
    key: "d-attach-turn",
    deviceId: "d-attach-turn",
    identityId: "i",
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    end: () => {},
  });
  const lease = broker.lease({
    key: "d-attach-turn",
    signal: new AbortController().signal,
    turnId: "turn-A",
  });

  const wrong = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { turnId: "turn-B", seq: 0, path: "x" },
    "/attachment",
  );
  assertEqual(wrong.status, 409, "an attachment for another turn is rejected");
  assert(
    !writes.some((w) => w.includes("response_attachment")),
    "a mismatched attachment never reaches the device",
  );

  const right = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { turnId: "turn-A", seq: 0, path: "x" },
    "/attachment",
  );
  assertEqual(
    right.status,
    202,
    "an attachment for the leased turn is relayed",
  );
  lease.revoke();
  console.log("ok an attachment notice must match the leased turn id");
}

async function verifyAttachmentToGoneDevice(broker: ToolBroker): Promise<void> {
  // A turn leased for a device that never connected: an attachment notice has
  // nowhere to land, so the broker answers 503 and the tool surfaces that to
  // the model rather than silently dropping it.
  const lease = broker.lease({
    key: "d-attach-ghost",
    signal: new AbortController().signal,
  });
  const response = await postCall(
    lease.ticket.url,
    lease.ticket.token,
    { turnId: "turn-1", seq: 0, path: "x" },
    "/attachment",
  );
  assertEqual(
    response.status,
    503,
    "an attachment to an absent device returns 503",
  );
  lease.revoke();
  console.log("ok an attachment to an unconnected device returns 503");
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
  identityId = "i",
): void {
  registry.connect({
    key,
    deviceId: key,
    identityId,
    write: (chunk) => {
      const match = /event: tool_call\ndata: (.*)\n\n/s.exec(chunk);
      if (!match || match[1] === undefined) return true;
      const dispatch: unknown = JSON.parse(match[1]);
      const record = asRecord(dispatch);
      const id = record?.["id"];
      const tool = record?.["tool"];
      if (typeof id !== "string" || typeof tool !== "string") return true;
      queueMicrotask(() => {
        registry.settleResult(key, respond({ id, tool }));
      });
      return true;
    },
    end: () => {},
  });
}

type HttpResult = { status: number; body: unknown };

function postCall(
  baseUrl: string,
  token: string,
  body: unknown,
  path = "/call",
): Promise<HttpResult> {
  return new Promise((resolvePost, rejectPost) => {
    const target = new URL(path, baseUrl);
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

await verifyToolBroker();
