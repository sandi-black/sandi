import { createServer, type Server } from "node:http";

import { assert, assertEqual } from "../../../lib/verification/harness";
import {
  postDiscordFile,
  readBrokerTarget,
} from "./attach-desktop-file-to-discord";

export async function verifyDiscordDesktopFileTool(): Promise<void> {
  verifyTargetBoundary();
  await withServer(async (url, setMode, received) => {
    const target = { url, token: "a".repeat(64) };
    const result = await postDiscordFile(target, {
      path: "C:/Users/grace/Desktop/plot.png",
      name: "plot.png",
    });
    assertEqual(
      result.name,
      "plot.png",
      "the tool reads the accepted filename",
    );
    assertEqual(result.size, 8, "the tool reads the accepted byte count");
    assert(
      JSON.stringify(received()).includes("grace"),
      "the tool posts the desktop path to the broker",
    );

    setMode("failure");
    await assertRejects(
      () => postDiscordFile(target, { path: "missing.png" }),
      "device_unavailable",
      "a disconnected desktop is explicit",
    );

    setMode("partial");
    await assertRejects(
      () => postDiscordFile(target, { path: "plot.png" }),
      "transfer failed",
      "a partial broker response fails promptly",
    );

    const controller = new AbortController();
    controller.abort();
    await assertRejects(
      () => postDiscordFile(target, { path: "plot.png" }, controller.signal),
      "cancelled",
      "a cancelled tool call aborts before transfer",
    );
  });
  console.log(
    "ok the Discord desktop-file tool validates and posts broker calls",
  );
}

function verifyTargetBoundary(): void {
  const url = process.env["SANDI_TOOL_BROKER_URL"];
  const token = process.env["SANDI_TOOL_BROKER_TOKEN"];
  try {
    delete process.env["SANDI_TOOL_BROKER_URL"];
    delete process.env["SANDI_TOOL_BROKER_TOKEN"];
    assertEqual(
      readBrokerTarget(),
      undefined,
      "missing broker env is disabled",
    );
    process.env["SANDI_TOOL_BROKER_URL"] = "https://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = "a".repeat(64);
    assertEqual(readBrokerTarget(), undefined, "non-loopback HTTP is rejected");
    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    assertEqual(
      readBrokerTarget()?.token,
      "a".repeat(64),
      "a loopback broker and strong token are accepted",
    );
  } finally {
    restore("SANDI_TOOL_BROKER_URL", url);
    restore("SANDI_TOOL_BROKER_TOKEN", token);
  }
}

async function withServer(
  action: (
    url: string,
    setMode: (value: "success" | "failure" | "partial") => void,
    received: () => unknown,
  ) => Promise<void>,
): Promise<void> {
  let mode: "success" | "failure" | "partial" = "success";
  let body: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (mode === "partial") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"ok":');
        response.destroy();
        return;
      }
      response.writeHead(mode === "failure" ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          mode === "failure"
            ? { error: "device_unavailable" }
            : { ok: true, name: "plot.png", size: 8 },
        ),
      );
    });
  });
  const url = await listen(server);
  try {
    await action(
      url,
      (value) => {
        mode = value;
      },
      () => body,
    );
  } finally {
    server.close();
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server had no address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function assertRejects(
  action: () => Promise<unknown>,
  expected: string,
  message: string,
): Promise<void> {
  let actual = "";
  try {
    await action();
  } catch (error) {
    actual = error instanceof Error ? error.message : String(error);
  }
  assert(actual.includes(expected), `${message}: ${actual}`);
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
