import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { assert, assertEqual, withTempDir } from "@/lib/verification/harness";
import {
  type DesktopClientRuntime,
  desktopReconnectDelay,
  runDesktopClient,
} from "@/surfaces/api/client/desktop-client";
import {
  DeviceResultSchema,
  type ResponseAttachment,
  type ResponseChunk,
} from "@/surfaces/api/devices/protocol";

// Exercises the desktop transport against deliberately fragmented and hostile
// peers. These checks cover behavior that unit-level executor checks cannot:
// framing, connection lifecycle, dispatch admission, and result cancellation.

type ResultRow = {
  id: string;
  ok: boolean;
  hasImage: boolean;
  error?: string;
};

async function verifyDesktopClient(): Promise<void> {
  await verifyDispatchFlow();
  await verifyResultPostConcurrency();
  await verifyCancelAbortsResultPost();
  await verifyHandshakeGuards();
  await verifySseFrameLimit();
  await verifyReconnectReset();
  verifyReconnectJitter();

  console.log("desktop client verification passed");
}

async function verifyResultPostConcurrency(): Promise<void> {
  await withTempDir("sandi-desktop-result-cap-", async (dir) => {
    const limit = 2;
    const invalidIds = Array.from({ length: 12 }, () => randomUUID());
    const overloadIds = Array.from({ length: 12 }, () => randomUUID());
    const droppedIds: string[] = Array.from({ length: 6 }, () => randomUUID());
    const heldIds: string[] = [randomUUID(), randomUUID()];
    const expectedResults = invalidIds.length + overloadIds.length;
    const results: ResultRow[] = [];
    const statuses: string[] = [];
    let activePosts = 0;
    let maxActivePosts = 0;
    let resultRequests = 0;
    let finishedResponses = 0;
    let releaseResponses: (() => void) | undefined;
    const responsesReleased = new Promise<void>((resolve) => {
      releaseResponses = resolve;
    });
    let markInitialPosts: (() => void) | undefined;
    const initialPosts = new Promise<void>((resolve) => {
      markInitialPosts = resolve;
    });
    let markAllResponsesFinished: (() => void) | undefined;
    const allResponsesFinished = new Promise<void>((resolve) => {
      markAllResponsesFinished = resolve;
    });

    const server = createServer((req, res) => {
      if (req.url === "/v1/devices/link" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();

        const holdCommand = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
        const frames = heldIds.map((id) =>
          formatEvent("tool_call", {
            id,
            tool: "local_bash",
            params: { command: holdCommand },
          }),
        );
        frames.push(
          formatEvent("tool_call", {
            id: heldIds[0],
            tool: "local_bash",
            params: { command: holdCommand },
          }),
          formatEvent("tool_call", {
            id: heldIds[0],
            tool: "invalid_tool",
            params: {},
          }),
          ...invalidIds.map((id) =>
            formatEvent("tool_call", {
              id,
              tool: "invalid_tool",
              params: {},
            }),
          ),
          ...overloadIds.map((id, index) =>
            formatEvent("tool_call", {
              id,
              tool: "local_write",
              params: {
                path: `${dir}/overload-${index}.txt`,
                content: "must not run",
              },
            }),
          ),
          ...droppedIds.map((id) =>
            formatEvent("tool_call", {
              id,
              tool: "invalid_tool",
              params: {},
            }),
          ),
          formatEvent("response_chunk", {
            type: "end",
            turnId: "result-cap-flood",
            seq: 0,
          }),
        );
        res.write(frames.join(""));
        return;
      }
      if (req.url === "/v1/devices/result" && req.method === "POST") {
        activePosts += 1;
        resultRequests += 1;
        maxActivePosts = Math.max(maxActivePosts, activePosts);
        if (resultRequests === limit) markInitialPosts?.();

        let responseSettled = false;
        const onResponseSettled = (): void => {
          if (responseSettled) return;
          responseSettled = true;
          activePosts -= 1;
          finishedResponses += 1;
          if (finishedResponses === expectedResults) {
            markAllResponsesFinished?.();
          }
        };
        res.once("finish", onResponseSettled);
        res.once("close", onResponseSettled);
        void readResult(req).then(async (row) => {
          if (row) results.push(row);
          await responsesReleased;
          res.writeHead(200).end();
        });
        return;
      }
      res.writeHead(404).end();
    });

    const port = await listen(server);
    const controller = new AbortController();
    let markFloodParsed: (() => void) | undefined;
    const floodParsed = new Promise<void>((resolve) => {
      markFloodParsed = resolve;
    });
    const clientDone = runDesktopClient(
      {
        credentials: credentials(port),
        rootDir: process.cwd(),
        signal: controller.signal,
        onStatus: (message) => statuses.push(message),
        onResponseChunk: (chunk) => {
          if (chunk.type === "end" && chunk.turnId === "result-cap-flood") {
            markFloodParsed?.();
          }
        },
      },
      {
        maxInflightToolCalls: limit,
        maxPendingResultPosts: expectedResults - limit,
      },
    );

    try {
      await Promise.race([
        Promise.all([floodParsed, initialPosts]),
        timeout(2_000, "timed out waiting for the result POST flood"),
      ]);
      await yieldEventLoop(20);
      assertEqual(
        resultRequests,
        limit,
        "blocked result responses admit exactly the fixed POST limit",
      );
      assertEqual(
        maxActivePosts,
        limit,
        "invalid and overload refusals share the result POST limit",
      );

      releaseResponses?.();
      await Promise.race([
        allResponsesFinished,
        timeout(5_000, "timed out draining bounded result POSTs"),
      ]);
      assertEqual(
        maxActivePosts,
        limit,
        "draining the refusal flood never exceeds the result POST limit",
      );

      for (const id of invalidIds) {
        const result = results.find((row) => row.id === id);
        assertEqual(
          result?.error,
          "invalid tool call",
          "an invalid dispatch still receives a useful refusal",
        );
      }
      for (const id of overloadIds) {
        const result = results.find((row) => row.id === id);
        assertEqual(
          result?.error,
          `too many tool calls in flight (limit ${limit})`,
          "an overload dispatch still receives a useful refusal",
        );
      }
      assert(
        !results.some((row) => droppedIds.includes(row.id)),
        "dispatches beyond the fixed result queue are dropped",
      );
      assertEqual(
        statuses.filter((message) =>
          message.includes("dropped a tool result because its queue is full"),
        ).length,
        droppedIds.length,
        "a saturated result queue reports every dropped result",
      );
      assert(
        !results.some((row) => heldIds.includes(row.id)),
        "valid and malformed duplicates cannot settle an active call",
      );
      assertEqual(
        statuses.filter((message) =>
          message.includes(
            `dropped duplicate active tool call id ${heldIds[0]}`,
          ),
        ).length,
        2,
        "valid and malformed active-id replays are both surfaced as duplicates",
      );
      console.log(
        "ok invalid and overload result POSTs share a strict concurrency cap",
      );
    } finally {
      releaseResponses?.();
      controller.abort();
      await clientDone;
      await closeServer(server);
    }
  });
}

async function verifyDispatchFlow(): Promise<void> {
  await withTempDir("sandi-desktop-client-", async (dir) => {
    const results: ResultRow[] = [];
    const waiters = new Map<string, () => void>();
    const statuses: string[] = [];

    const awaitResult = (id: string): Promise<void> =>
      new Promise((resolve) => {
        if (results.some((row) => row.id === id)) {
          resolve();
          return;
        }
        waiters.set(id, resolve);
      });

    const holdId = randomUUID();
    const duplicateId = randomUUID();
    const screenshotId = randomUUID();
    const overflowId = randomUUID();
    let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

    const streamed: ResponseChunk[] = [];
    let markStreamEnd: (() => void) | undefined;
    const streamEnded = new Promise<void>((resolve) => {
      markStreamEnd = resolve;
    });

    const attachments: ResponseAttachment[] = [];
    let markAttachment: (() => void) | undefined;
    const attachmentReceived = new Promise<void>((resolve) => {
      markAttachment = resolve;
    });

    const server = createServer((req, res) => {
      if (req.url === "/v1/devices/link" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "Text/Event-Stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders();

        // Hold back the final LF of a CRLF delimiter. The parser must preserve
        // the partial boundary across chunks before delivering the event.
        const firstFrame = formatEvent(
          "response_chunk",
          {
            type: "delta",
            turnId: "turn-1",
            seq: 0,
            channel: "text",
            delta: "Hel",
          },
          "\r\n",
        );
        res.write(firstFrame.slice(0, -1));
        dispatchTimer = setTimeout(() => {
          res.write(firstFrame.slice(-1));

          const holdCommand = `"${process.execPath}" -e "setTimeout(()=>console.log('done'),600)"`;
          const duplicateCommand = `"${process.execPath}" -e "require('node:fs').appendFileSync('duplicate.txt','x');setTimeout(()=>console.log('done'),400)"`;

          // Keep all dispatches in one write so admission is deterministic: the
          // fourth distinct call reaches the client while three calls are active.
          const frames = [
            formatEvent(
              "response_chunk",
              {
                type: "delta",
                turnId: "turn-1",
                seq: 1,
                channel: "text",
                delta: "lo",
              },
              "\r\n",
            ),
            formatEvent(
              "response_chunk",
              { type: "end", turnId: "turn-1", seq: 2 },
              "\r\n",
            ),
            formatEvent(
              "response_attachment",
              {
                turnId: "turn-1",
                seq: 0,
                path: "C:/Users/hopper/Desktop/plot.png",
                name: "plot.png",
              },
              "\r\n",
            ),
            formatEvent(
              "tool_call",
              {
                id: holdId,
                tool: "local_bash",
                params: { command: holdCommand },
              },
              "\r\n",
            ),
            formatEvent(
              "tool_call",
              {
                id: duplicateId,
                tool: "local_bash",
                params: { command: duplicateCommand },
              },
              "\r\n",
            ),
            formatEvent(
              "tool_call",
              {
                id: duplicateId,
                tool: "local_bash",
                params: { command: duplicateCommand },
              },
              "\r\n",
            ),
            formatEvent(
              "tool_call",
              {
                id: screenshotId,
                tool: "local_screenshot",
                params: { maxDimension: 256 },
              },
              "\r\n",
            ),
            formatEvent(
              "tool_call",
              {
                id: overflowId,
                tool: "local_write",
                params: { path: "overflow.txt", content: "must not exist" },
              },
              "\r\n",
            ),
          ];
          res.write(frames.join(""));
        }, 10);
        return;
      }
      if (req.url === "/v1/devices/result" && req.method === "POST") {
        void readResult(req).then((row) => {
          if (row) {
            results.push(row);
            waiters.get(row.id)?.();
            waiters.delete(row.id);
          }
          res.writeHead(200).end();
        });
        return;
      }
      res.writeHead(404).end();
    });

    const port = await listen(server);
    const controller = new AbortController();
    const clientDone = runDesktopClient(
      {
        credentials: credentials(port),
        rootDir: dir,
        signal: controller.signal,
        onStatus: (message) => statuses.push(message),
        onResponseChunk: (chunk) => {
          streamed.push(chunk);
          if (chunk.type === "end") markStreamEnd?.();
        },
        onResponseAttachment: (attachment) => {
          attachments.push(attachment);
          markAttachment?.();
        },
      },
      { maxInflightToolCalls: 3 },
    );

    try {
      await Promise.race([
        Promise.all([
          awaitResult(holdId),
          awaitResult(duplicateId),
          awaitResult(screenshotId),
          awaitResult(overflowId),
          streamEnded,
          attachmentReceived,
        ]),
        timeout(10_000, "timed out waiting for dispatch results"),
      ]);
      await delay(100);

      assertEqual(
        attachments,
        [
          {
            turnId: "turn-1",
            seq: 0,
            path: "C:/Users/hopper/Desktop/plot.png",
            name: "plot.png",
          },
        ],
        "the CRLF-framed attachment reaches its callback",
      );

      const text = streamed
        .filter((chunk) => chunk.type === "delta" && chunk.channel === "text")
        .map((chunk) => (chunk.type === "delta" ? chunk.delta : ""))
        .join("");
      assertEqual(text, "Hello", "fragmented CRLF text deltas arrive in order");
      assert(
        streamed.some((chunk) => chunk.type === "end"),
        "the fragmented response stream delivers an end marker",
      );

      const held = results.find((row) => row.id === holdId);
      assert(held?.ok === true, "the capacity-holding dispatch completes");

      const duplicateResults = results.filter((row) => row.id === duplicateId);
      assertEqual(
        duplicateResults.length,
        1,
        "a duplicate active dispatch produces one result",
      );
      assert(
        duplicateResults[0]?.ok === true,
        "the original duplicate-id dispatch completes",
      );
      assertEqual(
        await readFile(`${dir}/duplicate.txt`, "utf8"),
        "x",
        "a duplicate active dispatch performs its side effect once",
      );
      assert(
        statuses.some((message) =>
          message.includes(
            `dropped duplicate active tool call id ${duplicateId}`,
          ),
        ),
        "a duplicate active dispatch is surfaced in status",
      );

      const overflow = results.find((row) => row.id === overflowId);
      assert(overflow !== undefined, "an over-cap dispatch receives a result");
      assert(
        overflow.ok === false && overflow.error?.includes("limit 3") === true,
        "an over-cap dispatch receives a bounded-capacity error",
      );
      const overflowExists = await readFile(`${dir}/overflow.txt`, "utf8").then(
        () => true,
        () => false,
      );
      assert(!overflowExists, "an over-cap dispatch performs no side effect");

      const screenshot = results.find((row) => row.id === screenshotId);
      assert(screenshot !== undefined, "the screenshot call reports a result");
      if (screenshot.ok) {
        assert(
          screenshot.hasImage,
          "a successful screenshot POSTs an image-bearing result",
        );
      }
      console.log(
        "ok fragmented CRLF events, duplicate ids, and the inflight cap",
      );
    } finally {
      if (dispatchTimer) clearTimeout(dispatchTimer);
      controller.abort();
      await clientDone;
      await closeServer(server);
    }
  });
}

async function verifyCancelAbortsResultPost(): Promise<void> {
  await withTempDir("sandi-desktop-result-abort-", async (dir) => {
    const id = randomUUID();
    let linkResponse: ServerResponse | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let markResultStarted: (() => void) | undefined;
    const resultStarted = new Promise<void>((resolve) => {
      markResultStarted = resolve;
    });
    let markResultClosed: (() => void) | undefined;
    const resultClosed = new Promise<void>((resolve) => {
      markResultClosed = resolve;
    });

    const server = createServer((req, res) => {
      if (req.url === "/v1/devices/link" && req.method === "GET") {
        linkResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        const frame = formatEvent("tool_call", {
          id,
          tool: "local_bash",
          params: { command: "echo done" },
        });
        res.write(frame.slice(0, -1));
        frameTimer = setTimeout(() => res.write(frame.slice(-1)), 10);
        return;
      }
      if (req.url === "/v1/devices/result" && req.method === "POST") {
        res.on("close", () => markResultClosed?.());
        void readResult(req).then(() => {
          markResultStarted?.();
          if (linkResponse) writeEvent(linkResponse, "tool_cancel", { id });
          // Intentionally never end this response. The per-call abort signal
          // must tear down the POST instead of waiting for its 30-second timeout.
        });
        return;
      }
      res.writeHead(404).end();
    });

    const port = await listen(server);
    const controller = new AbortController();
    const clientDone = runDesktopClient({
      credentials: credentials(port),
      rootDir: dir,
      signal: controller.signal,
    });

    try {
      await Promise.race([
        Promise.all([resultStarted, resultClosed]),
        timeout(2_000, "a cancelled result POST remained open"),
      ]);
      console.log("ok tool cancellation aborts an in-progress result POST");
    } finally {
      if (frameTimer) clearTimeout(frameTimer);
      controller.abort();
      await clientDone;
      await closeServer(server);
    }
  });
}

async function verifyHandshakeGuards(): Promise<void> {
  await verifyLinkDrop(
    createServer(() => {
      // Accept the request but never send headers. The handshake timer must own
      // the entire pre-response interval, including this silent peer state.
    }),
    { handshakeTimeoutMs: 50, reconnectDelay: () => 0 },
    "device link handshake timed out after 50ms",
  );

  await verifyLinkDrop(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }),
    { reconnectDelay: () => 0 },
    "device link did not return text/event-stream",
  );

  await verifyLinkDrop(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    }),
    { idleTimeoutMs: 50, reconnectDelay: () => 0 },
    "device link was idle for 50ms",
  );

  console.log(
    "ok the link handshake and heartbeat path have total timeout guards",
  );
}

async function verifySseFrameLimit(): Promise<void> {
  await verifyLinkDrop(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write(`data: ${"x".repeat(65)}`);
    }),
    { maxSseEventChars: 64, reconnectDelay: () => 0 },
    "device link SSE event exceeded 64 characters",
  );

  console.log("ok an unterminated SSE event cannot grow the client buffer");
}

async function verifyReconnectReset(): Promise<void> {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    if (requests <= 2) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    setImmediate(() => res.end());
  });
  const port = await listen(server);
  const controller = new AbortController();
  const attempts: number[] = [];
  const clientDone = runDesktopClient(
    {
      credentials: credentials(port),
      rootDir: process.cwd(),
      signal: controller.signal,
    },
    {
      reconnectDelay: (attempt) => {
        attempts.push(attempt);
        if (attempts.length === 3) controller.abort();
        return 0;
      },
    },
  );

  try {
    await Promise.race([
      clientDone,
      timeout(2_000, "timed out waiting for reconnect attempts"),
    ]);
    assertEqual(
      attempts,
      [0, 1, 0],
      "a successful handshake resets the reconnect backoff",
    );
    assertEqual(requests, 3, "the reset check establishes exactly three links");
    console.log("ok a successful handshake resets reconnect backoff");
  } finally {
    controller.abort();
    await clientDone;
    await closeServer(server);
  }
}

function verifyReconnectJitter(): void {
  assertEqual(
    desktopReconnectDelay(0, () => 0),
    500,
    "the lowest base-delay jitter is deterministic",
  );
  assertEqual(
    desktopReconnectDelay(0, () => 1),
    1_000,
    "the highest base-delay jitter is deterministic",
  );
  assertEqual(
    desktopReconnectDelay(20, () => 1),
    30_000,
    "reconnect jitter respects the maximum delay",
  );
  console.log("ok reconnect delays are bounded and jittered");
}

async function verifyLinkDrop(
  server: Server,
  runtime: DesktopClientRuntime,
  expectedStatus: string,
): Promise<void> {
  const port = await listen(server);
  const controller = new AbortController();
  const statuses: string[] = [];
  const clientDone = runDesktopClient(
    {
      credentials: credentials(port),
      rootDir: process.cwd(),
      signal: controller.signal,
      onStatus: (message) => {
        statuses.push(message);
        if (message.includes(expectedStatus)) controller.abort();
      },
    },
    runtime,
  );

  try {
    await Promise.race([
      clientDone,
      timeout(2_000, `timed out waiting for status: ${expectedStatus}`),
    ]);
    assert(
      statuses.some((message) => message.includes(expectedStatus)),
      `the client surfaces: ${expectedStatus}`,
    );
  } finally {
    controller.abort();
    await clientDone;
    await closeServer(server);
  }
}

function credentials(port: number): {
  url: string;
  token: string;
  deviceId: string;
  identityId: string;
} {
  return {
    url: `http://127.0.0.1:${port}`,
    token: "test-token",
    deviceId: "device-1",
    identityId: "tester",
  };
}

function formatEvent(event: string, data: unknown, lineEnding = "\n"): string {
  return `event: ${event}${lineEnding}data: ${JSON.stringify(data)}${lineEnding}${lineEnding}`;
}

function writeEvent(
  res: { write: (chunk: string) => void },
  event: string,
  data: unknown,
  lineEnding = "\n",
): void {
  res.write(formatEvent(event, data, lineEnding));
}

async function readResult(
  req: IncomingMessage,
): Promise<ResultRow | undefined> {
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = DeviceResultSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return {
    id: result.data.id,
    ok: result.data.ok,
    hasImage: result.data.image !== undefined,
    ...(result.data.error !== undefined ? { error: result.data.error } : {}),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind a TCP port");
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function yieldEventLoop(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    // This guard should not hold the process open after the behavior wins.
    setTimeout(() => reject(new Error(message)), ms).unref();
  });
}

await verifyDesktopClient();
