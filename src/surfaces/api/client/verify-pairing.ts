import { createServer, type Server, type ServerResponse } from "node:http";

import { assert, assertEqual } from "@/lib/verification/harness";
import { pairDesktop } from "@/surfaces/api/client/pairing";

// Drives the client pairing flow against a stand-in api surface: a successful
// redemption returns storable credentials, and each error status maps to a clear
// message instead of a raw status code.

type Reply = { status: number; body: unknown };

// A 64-char hex stand-in for the minted per-device token, the only shape the
// pairing response schema accepts.
const DEVICE_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function verifyPairing(): Promise<void> {
  await withServer({ status: 200, body: okBody("my-laptop") }, async (url) => {
    const outcome = await pairDesktop({ url, code: "ABCD1234" });
    assert(outcome.ok, "a 200 yields a successful outcome");
    if (outcome.ok) {
      assertEqual(outcome.credentials.token, DEVICE_TOKEN, "token is stored");
      assertEqual(outcome.credentials.url, url, "the server url is stored");
      assertEqual(outcome.label, "my-laptop", "the server label is used");
    }
    console.log("ok a successful redemption returns storable credentials");
  });

  // When the server omits a label, the client's own label argument stands in.
  await withServer({ status: 200, body: okBody() }, async (url) => {
    const outcome = await pairDesktop({ url, code: "ABCD1234", label: "mine" });
    assert(
      outcome.ok && outcome.label === "mine",
      "the client label falls back",
    );
    console.log("ok the client label is used when the server omits one");
  });

  await assertMessage(
    { status: 401, body: { error: "invalid_code" } },
    "invalid or expired",
    "a 401 explains the code is invalid",
  );
  await assertMessage(
    { status: 403, body: { error: "identity_unmapped" } },
    "no longer mapped",
    "a 403 explains the identity mapping",
  );
  await assertMessage(
    { status: 429, body: { error: "rate_limited" } },
    "too many attempts",
    "a 429 explains the throttle",
  );

  // An unreachable server is a reachability error, not a crash.
  const unreachable = await pairDesktop({
    url: "http://127.0.0.1:1",
    code: "ABCD1234",
  });
  assert(
    !unreachable.ok && unreachable.error.includes("could not reach"),
    "an unreachable server reports a reachability error",
  );
  console.log("ok an unreachable server reports a reachability error");

  console.log("client pairing verification passed");
}

function okBody(label?: string): Record<string, unknown> {
  return {
    surface: "api",
    token: DEVICE_TOKEN,
    deviceId: "device-1",
    identityId: "tester",
    ...(label !== undefined ? { label } : {}),
  };
}

async function assertMessage(
  reply: Reply,
  needle: string,
  label: string,
): Promise<void> {
  await withServer(reply, async (url) => {
    const outcome = await pairDesktop({ url, code: "ABCD1234" });
    assert(
      !outcome.ok && outcome.error.includes(needle),
      `${label} (got ${outcome.ok ? "ok" : outcome.error})`,
    );
    console.log(`ok ${label}`);
  });
}

async function withServer(
  reply: Reply,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url !== "/v1/auth/pair" || request.method !== "POST") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    request.on("data", () => {});
    request.on("end", () => respond(response, reply.status, reply.body));
  });
  const url = await listen(server);
  try {
    await run(url);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

await verifyPairing();
