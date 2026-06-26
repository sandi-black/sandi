import { createServer, type Server, type ServerResponse } from "node:http";

import { type Broker, callTool, readBroker } from "./local-exec-tools";

// Drives the proxy extension's network helpers against a stand-in broker so the
// routing and the ok/refused/unavailable mapping are exercised without a real
// pi child or desktop.

type ServerMode =
  | { kind: "ok"; output: string }
  | { kind: "refuse"; error: string }
  | { kind: "status"; status: number };

async function verifyLocalExecTools(): Promise<void> {
  verifyReadBroker();
  await withBroker(async (broker, setMode, lastAuth) => {
    setMode({ kind: "ok", output: "hello from desktop" });
    const result = await callTool(broker, "local_read", { path: "x" });
    assertEqual(
      textOf(result),
      "hello from desktop",
      "ok outcome returns output",
    );
    assertEqual(
      lastAuth(),
      `Bearer ${broker.token}`,
      "the call carries the broker bearer token",
    );
    console.log(
      "ok an ok outcome is returned as tool text with the bearer token",
    );

    setMode({ kind: "refuse", error: "permission denied" });
    await assertThrows(
      () => callTool(broker, "local_bash", { command: "x" }),
      "permission denied",
      "a refused outcome throws with its error",
    );
    console.log("ok a refused outcome throws a tool error");

    setMode({ kind: "status", status: 503 });
    await assertThrows(
      () => callTool(broker, "local_read", { path: "x" }),
      "not connected",
      "a 503 throws a device-unavailable error",
    );
    console.log("ok a 503 surfaces as a device-unavailable error");

    setMode({ kind: "status", status: 500 });
    await assertThrows(
      () => callTool(broker, "local_read", { path: "x" }),
      "status 500",
      "an unexpected status throws with the status",
    );
    console.log("ok an unexpected broker status throws");
  });
  console.log("local exec tools verification passed");
}

function verifyReadBroker(): void {
  const url = process.env["SANDI_TOOL_BROKER_URL"];
  const token = process.env["SANDI_TOOL_BROKER_TOKEN"];
  delete process.env["SANDI_TOOL_BROKER_URL"];
  delete process.env["SANDI_TOOL_BROKER_TOKEN"];
  try {
    assertEqual(readBroker(), undefined, "no broker env yields undefined");
    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = "tok";
    const broker = readBroker();
    assertEqual(
      broker?.url,
      "http://127.0.0.1:1",
      "broker url is read from env",
    );
    assertEqual(broker?.token, "tok", "broker token is read from env");
    console.log("ok readBroker reflects the broker env vars");
  } finally {
    restoreEnv("SANDI_TOOL_BROKER_URL", url);
    restoreEnv("SANDI_TOOL_BROKER_TOKEN", token);
  }
}

async function withBroker(
  run: (
    broker: Broker,
    setMode: (mode: ServerMode) => void,
    lastAuth: () => string | undefined,
  ) => Promise<void>,
): Promise<void> {
  let mode: ServerMode = { kind: "ok", output: "" };
  let auth: string | undefined;
  const token = "broker-token";
  const server = createServer((request, response) => {
    auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      respond(response, 401, { error: "unauthorized" });
      return;
    }
    // Drain the body; its content does not change the scripted reply.
    request.on("data", () => {});
    request.on("end", () => {
      if (mode.kind === "ok") {
        respond(response, 200, { ok: true, output: mode.output });
      } else if (mode.kind === "refuse") {
        respond(response, 200, { ok: false, output: "", error: mode.error });
      } else {
        respond(response, mode.status, { error: "broker_error" });
      }
    });
  });
  const url = await listen(server);
  try {
    await run(
      { url, token },
      (next) => {
        mode = next;
      },
      () => auth,
    );
  } finally {
    server.close();
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolveListen(`http://127.0.0.1:${port}`);
    });
  });
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function textOf(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string | undefined {
  const first = result.content[0];
  if (first && first.type === "text") return first.text;
  return undefined;
}

async function assertThrows(
  run: () => Promise<unknown>,
  needle: string,
  label: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(needle)) return;
    console.error(`${label}: error "${message}" did not include "${needle}"`);
    process.exit(1);
  }
  console.error(`${label}: expected a throw but none happened`);
  process.exit(1);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

await verifyLocalExecTools();
