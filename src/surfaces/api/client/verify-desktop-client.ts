import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import { DeviceResultSchema } from "@/surfaces/api/devices/protocol";

// Exercises the desktop client against a fake api surface: it must run a
// dispatched tool and POST the outcome, and it must abandon a running command
// when the server sends a tool_cancel for it. This covers the seam the unit
// tests cannot, the SSE parse plus cancel plus result-report path end to end.

type ResultRow = { id: string; ok: boolean; error?: string };

async function verifyDesktopClient(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sandi-desktop-client-"));
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
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;

  const server = createServer((req, res) => {
    if (req.url === "/v1/devices/link" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
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
  });

  try {
    await Promise.race([
      Promise.all([awaitResult(cancelId), awaitResult(echoId)]),
      timeout(10_000),
    ]);

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
  } finally {
    if (cancelTimer) clearTimeout(cancelTimer);
    controller.abort();
    await clientDone;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }

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
    setTimeout(() => reject(new Error("timed out waiting for results")), ms);
  });
}

function assert(condition: unknown, label: string): asserts condition {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

await verifyDesktopClient();
