import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

import { runBoundedCommand } from "@/surfaces/discord/bot/startup-status";
import {
  fetchBoundedBytes,
  readAllowedFilePath,
  readBoundedFile,
  requestMultipartJson,
} from "@/surfaces/discord/runtime/discord";

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-discord-io-"));
const previousRunRoot = process.env["SANDI_JS_RUN_DIR"];

try {
  const allowedRoot = join(tempRoot, "allowed");
  const outsideRoot = join(tempRoot, "outside");
  const nestedRoot = join(allowedRoot, "nested");
  await Promise.all([
    mkdir(nestedRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  const allowedFile = join(nestedRoot, "ada.txt");
  const outsideFile = join(outsideRoot, "grace.txt");
  await Promise.all([
    writeFile(allowedFile, "Ada", "utf8"),
    writeFile(outsideFile, "Grace", "utf8"),
  ]);
  process.env["SANDI_JS_RUN_DIR"] = allowedRoot;

  const allowedRead = await readAllowedFilePath(allowedFile);
  assert.equal(allowedRead.path, await realpath(allowedFile));
  assert.equal(allowedRead.data.toString("utf8"), "Ada");
  await assert.rejects(readAllowedFilePath(outsideFile), /must resolve under/);

  const escapeLink = join(allowedRoot, "escape");
  await symlink(
    outsideRoot,
    escapeLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    readAllowedFilePath(join(escapeLink, "grace.txt")),
    /must resolve under/,
  );

  assert.equal(
    (await readBoundedFile(allowedFile, 3, "Fixture")).toString("utf8"),
    "Ada",
  );
  await assert.rejects(readBoundedFile(outsideFile, 4, "Fixture"), /too large/);
  await assert.rejects(
    readBoundedFile(nestedRoot, 32, "Fixture"),
    /regular file/,
  );

  await verifyBoundedDownloads();
  await verifyMultipartRequests();
  await verifyBoundedCommands();
} finally {
  if (previousRunRoot === undefined) delete process.env["SANDI_JS_RUN_DIR"];
  else process.env["SANDI_JS_RUN_DIR"] = previousRunRoot;
  await rm(tempRoot, { recursive: true, force: true });
}

async function verifyBoundedDownloads(): Promise<void> {
  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "transfer-encoding": "chunked",
      });
      response.write("Ada ");
      response.end("Lovelace");
    },
    async (url) => {
      const result = await fetchBoundedBytes(url.href, 32, 1_000);
      assert.equal(result.bytes.toString("utf8"), "Ada Lovelace");
      assert.equal(result.contentType, "text/plain");
    },
  );

  await withHttpServer(
    (_request, response) => {
      const compressed = gzipSync(Buffer.from("Ada Lovelace", "utf8"));
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(compressed.byteLength),
        "content-type": "text/plain",
      });
      response.end(compressed);
    },
    async (url) => {
      const result = await fetchBoundedBytes(url.href, 32, 1_000);
      assert.equal(result.bytes.toString("utf8"), "Ada Lovelace");
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": "65",
        "content-type": "application/octet-stream",
      });
      response.end(Buffer.alloc(65));
    },
    async (url) => {
      await assert.rejects(
        fetchBoundedBytes(url.href, 64, 1_000),
        /too large: 65 bytes/,
      );
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      });
      response.write(Buffer.alloc(65));
      response.end();
    },
    async (url) => {
      await assert.rejects(
        fetchBoundedBytes(url.href, 64, 1_000),
        /more than 64 bytes/,
      );
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": "64",
        "content-type": "application/octet-stream",
      });
      response.write("short");
      response.socket?.destroy();
    },
    async (url) => {
      await assert.rejects(fetchBoundedBytes(url.href, 64, 1_000));
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      });
      response.flushHeaders();
    },
    async (url) => {
      await assert.rejects(
        fetchBoundedBytes(url.href, 64, 50),
        /abort|deadline|timeout/i,
      );
    },
  );
}

async function verifyMultipartRequests(): Promise<void> {
  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"id":"ada"}');
    },
    async (url) => {
      assert.deepEqual(await multipartRequest(url), { id: "ada" });
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": "128",
        "content-type": "application/json",
      });
      response.end("x".repeat(128));
    },
    async (url) => {
      await assert.rejects(
        multipartRequest(url, 1_000, 32),
        /exceeded 32 bytes/,
      );
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      response.write(`{"value":"${"x".repeat(128)}`);
      response.end('"}');
    },
    async (url) => {
      await assert.rejects(
        multipartRequest(url, 1_000, 32),
        /exceeded 32 bytes/,
      );
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": "100",
        "content-type": "application/json",
      });
      response.write("{");
      response.socket?.destroy();
    },
    async (url) => {
      await assert.rejects(multipartRequest(url), /aborted|closed|socket/i);
    },
  );

  await withHttpServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      response.flushHeaders();
    },
    async (url) => {
      await assert.rejects(multipartRequest(url, 50), /deadline/);
    },
  );
}

function multipartRequest(
  url: URL,
  timeoutMs = 1_000,
  maxResponseBytes = 1_024,
): Promise<unknown> {
  return requestMultipartJson({
    url,
    headers: {},
    body: { content: "hello" },
    file: {
      data: Buffer.from("Ada", "utf8"),
      filename: "ada.txt",
      mimeType: "text/plain",
    },
    timeoutMs,
    maxResponseBytes,
  });
}

async function verifyBoundedCommands(): Promise<void> {
  const success = await runBoundedCommand(
    process.execPath,
    ["-e", 'process.stdout.write("Ada")'],
    { timeoutMs: 1_000, maxOutputBytes: 32 },
  );
  assert.deepEqual(success, { output: "Ada", succeeded: true });

  const overflow = await runBoundedCommand(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100000))'],
    { timeoutMs: 1_000, maxOutputBytes: 32 },
  );
  assert.equal(overflow.succeeded, false);
  assert.equal(Buffer.byteLength(overflow.output), 32);

  const startedAt = performance.now();
  const timedOut = await runBoundedCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 50, maxOutputBytes: 32 },
  );
  assert.equal(timedOut.succeeded, false);
  assert.ok(performance.now() - startedAt < 2_000);

  const missing = await runBoundedCommand(
    join(tempRoot, "missing-executable"),
    [],
    { timeoutMs: 1_000, maxOutputBytes: 32 },
  );
  assert.equal(missing.succeeded, false);
}

async function withHttpServer(
  listener: RequestListener,
  run: (url: URL) => Promise<void>,
): Promise<void> {
  const server = createServer(listener);
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Verification HTTP server did not expose a TCP port.");
    }
    await run(new URL(`http://127.0.0.1:${address.port}/test`));
  } finally {
    const closed = close(server);
    server.closeAllConnections();
    await closed;
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

console.log("discord I/O verification passed");
