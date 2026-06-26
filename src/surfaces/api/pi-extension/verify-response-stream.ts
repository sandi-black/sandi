import { createServer, type Server, type ServerResponse } from "node:http";

import {
  classifyAssistantEvent,
  createChunkRelay,
  intentToChunk,
  postChunk,
  readAssistantMessageEvent,
  readStreamTarget,
  type StreamTarget,
} from "./response-stream";

// Exercises the response-stream extension's pure classification, its env
// parsing, its intent-to-chunk mapping, the serialized relay that carries deltas
// to the broker, and the POST to the broker's streaming ingress, without a real
// pi child or desktop.

const HEX_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);

async function verifyResponseStream(): Promise<void> {
  verifyReadAssistantMessageEvent();
  verifyClassify();
  verifyIntentToChunk();
  verifyReadStreamTarget();
  await verifyChunkRelay();
  await verifyPostChunk();
  console.log("response stream verification passed");
}

function verifyReadAssistantMessageEvent(): void {
  assertEqual(
    readAssistantMessageEvent({
      assistantMessageEvent: { type: "text_delta", delta: "a" },
    }),
    { type: "text_delta", delta: "a" },
    "the inner event is read from the message_update envelope",
  );
  assertEqual(
    readAssistantMessageEvent(null),
    undefined,
    "a non-object envelope yields undefined",
  );
  assertEqual(
    readAssistantMessageEvent({}),
    undefined,
    "an envelope without the field yields undefined",
  );
  console.log("ok readAssistantMessageEvent narrows the pi event boundary");
}

function verifyIntentToChunk(): void {
  assertEqual(
    intentToChunk({ kind: "text", delta: "a" }),
    { type: "delta", channel: "text", delta: "a" },
    "a text intent becomes a text delta chunk",
  );
  assertEqual(
    intentToChunk({ kind: "thinking", delta: "h" }),
    { type: "delta", channel: "thinking", delta: "h" },
    "a thinking intent becomes a thinking delta chunk",
  );
  assertEqual(
    intentToChunk({ kind: "end" }),
    { type: "end" },
    "an end intent becomes an end chunk",
  );
  assertEqual(
    intentToChunk({ kind: "ignore" }),
    undefined,
    "an ignored intent yields no chunk",
  );
  console.log("ok intentToChunk maps streaming intents to wire chunks");
}

async function verifyChunkRelay(): Promise<void> {
  const target: StreamTarget = {
    url: "http://127.0.0.1:1",
    token: HEX_TOKEN,
    turnId: "turn-x",
  };

  // Sends run in generation order, each stamped with the turn id and the next
  // seq, even though the relay awaits the prior POST before the next.
  const sent: unknown[] = [];
  const relay = createChunkRelay(target, async (_t, chunk) => {
    sent.push(chunk);
    return 202;
  });
  relay.relay({ type: "delta", channel: "text", delta: "a" });
  relay.relay({ type: "delta", channel: "thinking", delta: "b" });
  relay.relay({ type: "end" });
  await relay.drain();
  assertEqual(
    sent,
    [
      { type: "delta", channel: "text", delta: "a", turnId: "turn-x", seq: 0 },
      {
        type: "delta",
        channel: "thinking",
        delta: "b",
        turnId: "turn-x",
        seq: 1,
      },
      { type: "end", turnId: "turn-x", seq: 2 },
    ],
    "relayed chunks carry the turn id and an increasing seq, in order",
  );
  assertEqual(relay.stopped, false, "a fully accepted stream is not stopped");

  // A non-202 stops the stream: the in-flight chunk was sent, later ones are not.
  const afterStop: unknown[] = [];
  const stopping = createChunkRelay(target, async (_t, chunk) => {
    afterStop.push(chunk);
    return 503;
  });
  stopping.relay({ type: "delta", channel: "text", delta: "x" });
  await stopping.drain();
  assertEqual(stopping.stopped, true, "a 503 stops the stream");
  stopping.relay({ type: "delta", channel: "text", delta: "y" });
  await stopping.drain();
  assertEqual(afterStop.length, 1, "no further chunk is sent after a stop");

  // A transport error is terminal too.
  const throwing = createChunkRelay(target, async () => {
    throw new Error("socket hangup");
  });
  throwing.relay({ type: "delta", channel: "text", delta: "z" });
  await throwing.drain();
  assertEqual(throwing.stopped, true, "a transport error stops the stream");

  console.log("ok createChunkRelay serializes, seqs, and stops on failure");
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
