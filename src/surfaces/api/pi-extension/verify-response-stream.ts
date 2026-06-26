import { createServer, type Server, type ServerResponse } from "node:http";

import {
  classifyAssistantEvent,
  postChunk,
  readStreamTarget,
  type StreamTarget,
} from "./response-stream";

// Exercises the response-stream extension's pure classification, its env
// parsing, and its POST to the broker's streaming ingress, without a real pi
// child or desktop.

const HEX_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);

async function verifyResponseStream(): Promise<void> {
  verifyClassify();
  verifyReadStreamTarget();
  await verifyPostChunk();
  console.log("response stream verification passed");
}

function verifyClassify(): void {
  assertEqual(
    classifyAssistantEvent({ type: "text_delta", delta: "hello" }),
    { kind: "text", delta: "hello" },
    "a text delta classifies as visible text",
  );
  assertEqual(
    classifyAssistantEvent({ type: "thinking_delta", delta: "hmm" }),
    { kind: "thinking", delta: "hmm" },
    "a thinking delta classifies as thinking",
  );
  assertEqual(
    classifyAssistantEvent({ type: "done", reason: "stop" }),
    { kind: "end" },
    "a stop ends the response stream",
  );
  assertEqual(
    classifyAssistantEvent({ type: "done", reason: "length" }),
    { kind: "end" },
    "a length stop ends the response stream",
  );
  assertEqual(
    classifyAssistantEvent({ type: "done", reason: "toolUse" }),
    { kind: "ignore" },
    "a tool-use stop is not the end (more text follows the tools)",
  );
  assertEqual(
    classifyAssistantEvent({ type: "toolcall_delta", delta: "{" }),
    { kind: "ignore" },
    "a tool-call delta is not part of the visible answer",
  );
  assertEqual(
    classifyAssistantEvent({ type: "text_delta" }),
    { kind: "ignore" },
    "a text delta without a string delta is ignored",
  );
  assertEqual(
    classifyAssistantEvent(null),
    { kind: "ignore" },
    "a non-object event is ignored",
  );
  console.log("ok classifyAssistantEvent maps pi events to streaming intents");
}

function verifyReadStreamTarget(): void {
  const priorUrl = process.env["SANDI_TOOL_BROKER_URL"];
  const priorToken = process.env["SANDI_TOOL_BROKER_TOKEN"];
  const priorTurn = process.env["SANDI_TURN_ID"];
  try {
    delete process.env["SANDI_TOOL_BROKER_URL"];
    delete process.env["SANDI_TOOL_BROKER_TOKEN"];
    delete process.env["SANDI_TURN_ID"];
    assertEqual(
      readStreamTarget(),
      undefined,
      "no streaming env yields undefined",
    );

    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = HEX_TOKEN;
    // Missing turn id alone disables streaming even with a valid broker.
    assertEqual(
      readStreamTarget(),
      undefined,
      "a missing turn id disables streaming",
    );

    process.env["SANDI_TURN_ID"] = "turn-1";
    const target = readStreamTarget();
    assertEqual(
      target,
      { url: "http://127.0.0.1:1", token: HEX_TOKEN, turnId: "turn-1" },
      "a full streaming env is read",
    );

    process.env["SANDI_TOOL_BROKER_URL"] = "http://10.0.0.5:1";
    assertEqual(
      readStreamTarget(),
      undefined,
      "a non-loopback broker url is rejected",
    );
    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = "too-short";
    assertEqual(readStreamTarget(), undefined, "a malformed token is rejected");
    console.log("ok readStreamTarget validates the streaming env");
  } finally {
    restoreEnv("SANDI_TOOL_BROKER_URL", priorUrl);
    restoreEnv("SANDI_TOOL_BROKER_TOKEN", priorToken);
    restoreEnv("SANDI_TURN_ID", priorTurn);
  }
}

async function verifyPostChunk(): Promise<void> {
  let lastBody: unknown;
  let lastAuth: string | undefined;
  let lastPath: string | undefined;
  let status = 202;
  const server = createServer((request, response) => {
    lastAuth = request.headers.authorization;
    lastPath = request.url;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      respond(response, status, { ok: status === 202 });
    });
  });
  const url = await listen(server);
  const target: StreamTarget = { url, token: HEX_TOKEN, turnId: "turn-1" };
  try {
    const chunk = {
      type: "delta",
      turnId: "turn-1",
      seq: 0,
      channel: "text",
      delta: "hi",
    };
    const accepted = await postChunk(target, chunk);
    assertEqual(accepted, 202, "the broker accepts a relayed delta with 202");
    assertEqual(lastPath, "/stream", "the delta is POSTed to /stream");
    assertEqual(
      lastAuth,
      `Bearer ${HEX_TOKEN}`,
      "the delta carries the broker bearer token",
    );
    assertEqual(lastBody, chunk, "the delta body is sent verbatim");

    status = 503;
    const gone = await postChunk(target, chunk);
    assertEqual(gone, 503, "a vanished device surfaces as 503");
    console.log("ok postChunk relays a delta and reports the broker status");
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
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  console.error(`${label}: expected ${b}, got ${a}`);
  process.exit(1);
}

await verifyResponseStream();
