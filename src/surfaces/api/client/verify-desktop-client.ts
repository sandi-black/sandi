import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { assert, assertEqual, withTempDir } from "@/lib/verification/harness";
import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import {
  DeviceResultSchema,
  type ResponseAttachment,
  type ResponseChunk,
} from "@/surfaces/api/devices/protocol";

// Exercises the desktop client against a fake api surface: it must run a
// dispatched tool and POST the outcome, abandon a running command when the
// server sends a tool_cancel for it, and surface streamed response_chunk and
// response_attachment events through their callbacks. This covers the seam the
// unit tests cannot, the SSE parse plus cancel plus result-report plus
// response-stream and outbound-attachment paths end to end.

type ResultRow = {
  id: string;
  ok: boolean;
  hasImage: boolean;
  error?: string;
};

async function verifyDesktopClient(): Promise<void> {
  await withTempDir("sandi-desktop-client-", async (dir) => {
    const results: ResultRow[] = [];
    const waiters = new Map<string, () => void>();

    // Resolves once a result with the given id lands.
    const awaitResult = (id: string): Promise<void> =>
      new Promise((resolve) => {
        if (results.some((row) => row.id === id)) {
          resolve();
          return;
        }
        waiters.set(id, resolve);
      });

    const cancelId = randomUUID();
    const echoId = randomUUID();
    const screenshotId = randomUUID();
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;

    const streamed: ResponseChunk[] = [];
    let markStreamEnd: (() => void) | undefined;
    const streamEnded = new Promise<void>((resolveEnd) => {
      markStreamEnd = resolveEnd;
    });

    const attachments: ResponseAttachment[] = [];
    let markAttachment: (() => void) | undefined;
    const attachmentReceived = new Promise<void>((resolveAttachment) => {
      markAttachment = resolveAttachment;
    });

    const server = createServer((req, res) => {
      if (req.url === "/v1/devices/link" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // A streamed response arriving as the turn runs: two text deltas then an
        // end marker. The client must surface each through onResponseChunk.
        writeEvent(res, "response_chunk", {
          type: "delta",
          turnId: "turn-1",
          seq: 0,
          channel: "text",
          delta: "Hel",
        });
        writeEvent(res, "response_chunk", {
          type: "delta",
          turnId: "turn-1",
          seq: 1,
          channel: "text",
          delta: "lo",
        });
        writeEvent(res, "response_chunk", {
          type: "end",
          turnId: "turn-1",
          seq: 2,
        });
        // An outbound attachment notice (as attach_to_reply would relay it) the
        // client must surface through onResponseAttachment.
        writeEvent(res, "response_attachment", {
          turnId: "turn-1",
          seq: 0,
          path: "C:/Users/hopper/Desktop/plot.png",
          name: "plot.png",
        });
        // A long-running command we will cancel, and a quick echo we let finish.
        const sleepCmd =
          process.platform === "win32"
            ? "ping -n 30 127.0.0.1 > NUL"
            : "sleep 30";
        writeEvent(res, "tool_call", {
          id: cancelId,
          tool: "local_bash",
          params: { command: sleepCmd },
        });
        writeEvent(res, "tool_call", {
          id: echoId,
          tool: "local_bash",
          params: { command: "echo done" },
        });
        // A screenshot exercises the image-bearing result POST end to end. On
        // Windows with a live session it returns an image; elsewhere (and in a
        // headless session) it refuses, so the assertion only requires that a
        // successful one carries an image through the real /v1/devices/result hop.
        writeEvent(res, "tool_call", {
          id: screenshotId,
          tool: "local_screenshot",
          params: { maxDimension: 256 },
        });
        // Cancel the long command shortly after dispatch.
        cancelTimer = setTimeout(() => {
          writeEvent(res, "tool_cancel", { id: cancelId });
        }, 150);
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
    const clientDone = runDesktopClient({
      credentials: {
        url: `http://127.0.0.1:${port}`,
        token: "test-token",
        deviceId: "device-1",
        identityId: "tester",
      },
      rootDir: dir,
      signal: controller.signal,
      onResponseChunk: (chunk) => {
        streamed.push(chunk);
        if (chunk.type === "end") markStreamEnd?.();
      },
      onResponseAttachment: (attachment) => {
        attachments.push(attachment);
        markAttachment?.();
      },
    });

    try {
      await Promise.race([
        Promise.all([
          awaitResult(cancelId),
          awaitResult(echoId),
          awaitResult(screenshotId),
          streamEnded,
          attachmentReceived,
        ]),
        timeout(10_000),
      ]);

      assertEqual(
        attachments.length,
        1,
        "one response_attachment event arrives",
      );
      const [attachment] = attachments;
      assertEqual(
        attachment?.path,
        "C:/Users/hopper/Desktop/plot.png",
        "the attachment's path reaches onResponseAttachment",
      );
      assertEqual(
        attachment?.name,
        "plot.png",
        "the attachment's name reaches onResponseAttachment",
      );
      console.log("ok a response_attachment event surfaces through the client");

      const text = streamed
        .filter((chunk) => chunk.type === "delta" && chunk.channel === "text")
        .map((chunk) => (chunk.type === "delta" ? chunk.delta : ""))
        .join("");
      assertEqual(text, "Hello", "the streamed text deltas arrive in order");
      assert(
        streamed.some((chunk) => chunk.type === "end"),
        "the response stream delivers an end marker",
      );
      console.log(
        "ok streamed response_chunk deltas surface through the client",
      );

      const cancelled = results.find((row) => row.id === cancelId);
      assert(cancelled !== undefined, "the cancelled call reported a result");
      assert(
        cancelled?.ok === false && cancelled.error === "cancelled",
        "a tool_cancel makes the desktop abandon the command and report cancelled",
      );
      console.log("ok a tool_cancel stops an in-flight command on the desktop");

      const echoed = results.find((row) => row.id === echoId);
      assert(echoed !== undefined, "the echo call reported a result");
      assert(echoed?.ok === true, "an uncancelled command runs to completion");
      console.log("ok an uncancelled command runs and reports its outcome");

      const shot = results.find((row) => row.id === screenshotId);
      assert(shot !== undefined, "the screenshot call reported a result");
      if (shot?.ok) {
        assert(
          shot.hasImage,
          "a successful screenshot POSTs an image-bearing result the server parses",
        );
        console.log(
          "ok a screenshot delivers its image through the result POST",
        );
      } else {
        console.log(
          "ok a screenshot with no live capture reports a refusal (no image expected)",
        );
      }
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      controller.abort();
      await clientDone;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  console.log("desktop client verification passed");
}

function writeEvent(
  res: { write: (chunk: string) => void },
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    // unref so this guard timer does not keep the process alive once the results
    // win the race; otherwise the run lingers for the full timeout after passing.
    setTimeout(() => {
      reject(new Error("timed out waiting for results"));
    }, ms).unref();
  });
}

await verifyDesktopClient();
