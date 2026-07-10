import { createServer, type Server } from "node:http";

import { assertEqual, isRecord } from "../../../lib/verification/harness";
import {
  type AttachTarget,
  attachedResult,
  noDesktopLinkResult,
  postAttachment,
  readAttachTarget,
} from "./attach-to-reply-tool";

// Exercises the extension's network helpers against a stand-in broker (the
// happy relay, a turn-mismatch-shaped 409, a gone-device 503, and an
// unexpected status), its env parsing, and the exact tool-result shapes the
// registered tool answers with, mirroring verify-local-exec-tools.ts. The
// registered tool's own execute() is a thin wrapper around readAttachTarget,
// postAttachment, and these two result builders (see attach-to-reply-tool.ts),
// so testing them directly covers both of its branches without standing up a
// fake ExtensionAPI.

type ServerMode = { kind: "accepted" } | { kind: "status"; status: number };

async function verifyAttachToReply(): Promise<void> {
  verifyReadAttachTarget();
  verifyToolResultShapes();
  await withBroker(async (target, setMode, lastAuth, lastBody) => {
    setMode({ kind: "accepted" });
    await postAttachment(target, {
      turnId: target.turnId,
      seq: 0,
      path: "C:/Users/grace/Desktop/plot.png",
    });
    assertEqual(
      lastAuth(),
      `Bearer ${target.token}`,
      "the attachment notice carries the broker bearer token",
    );
    const body = lastBody();
    assertEqual(
      isRecord(body) && body["path"],
      "C:/Users/grace/Desktop/plot.png",
      "the attachment notice carries the path",
    );
    console.log("ok a 202 from the broker resolves postAttachment");

    setMode({ kind: "status", status: 409 });
    await assertThrows(
      () =>
        postAttachment(target, { turnId: target.turnId, seq: 1, path: "x" }),
      "status 409",
      "a turn-mismatch status throws with the status included",
    );
    console.log("ok a turn-mismatch (409) response throws");

    setMode({ kind: "status", status: 503 });
    await assertThrows(
      () =>
        postAttachment(target, { turnId: target.turnId, seq: 2, path: "x" }),
      "not connected",
      "a 503 throws a device-unavailable error",
    );
    console.log("ok a 503 surfaces as a device-unavailable error");

    setMode({ kind: "status", status: 500 });
    await assertThrows(
      () =>
        postAttachment(target, { turnId: target.turnId, seq: 3, path: "x" }),
      "status 500",
      "an unexpected broker status throws",
    );
    console.log("ok an unexpected broker status throws");
  });
  console.log("attach_to_reply verification passed");
}

function verifyToolResultShapes(): void {
  assertEqual(
    noDesktopLinkResult(),
    {
      content: [
        {
          type: "text",
          text: "no desktop link on this surface: attach_to_reply is only available on a turn with a connected desktop",
        },
      ],
      details: { tool: "attach_to_reply", ok: false },
    },
    "a surface with no broker env answers the graceful no-desktop-link refusal, matching what execute() returns when readAttachTarget() is undefined",
  );
  assertEqual(
    attachedResult("plot.png"),
    {
      content: [{ type: "text", text: "attached plot.png to this reply" }],
      details: { tool: "attach_to_reply", ok: true },
    },
    "a successful relay answers a result naming the attachment, matching what execute() returns once postAttachment resolves",
  );
  console.log(
    "ok the tool answers its graceful refusal and its success result with the exact shapes execute() returns",
  );
}

function verifyReadAttachTarget(): void {
  const url = process.env["SANDI_TOOL_BROKER_URL"];
  const token = process.env["SANDI_TOOL_BROKER_TOKEN"];
  const turnId = process.env["SANDI_TURN_ID"];
  try {
    delete process.env["SANDI_TOOL_BROKER_URL"];
    delete process.env["SANDI_TOOL_BROKER_TOKEN"];
    delete process.env["SANDI_TURN_ID"];
    assertEqual(
      readAttachTarget(),
      undefined,
      "no broker env yields undefined: the tool answers its graceful no-desktop-link refusal rather than calling the broker",
    );

    const hexToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);
    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = hexToken;
    // A broker with no turn id is also disabled: attach_to_reply always needs a
    // turn to attribute the attachment to.
    assertEqual(
      readAttachTarget(),
      undefined,
      "a broker with no turn id is rejected",
    );

    process.env["SANDI_TURN_ID"] = "turn-1";
    const target = readAttachTarget();
    assertEqual(
      target,
      { url: "http://127.0.0.1:1", token: hexToken, turnId: "turn-1" },
      "a full env is read into an AttachTarget",
    );

    process.env["SANDI_TOOL_BROKER_URL"] = "https://127.0.0.1:1";
    assertEqual(readAttachTarget(), undefined, "a non-http url is rejected");
    process.env["SANDI_TOOL_BROKER_URL"] = "http://10.0.0.5:1";
    assertEqual(
      readAttachTarget(),
      undefined,
      "a non-loopback url is rejected",
    );
    process.env["SANDI_TOOL_BROKER_URL"] = "http://127.0.0.1:1";
    process.env["SANDI_TOOL_BROKER_TOKEN"] = "too-short";
    assertEqual(readAttachTarget(), undefined, "a malformed token is rejected");
    console.log("ok readAttachTarget validates the broker env and turn id");
  } finally {
    restoreEnv("SANDI_TOOL_BROKER_URL", url);
    restoreEnv("SANDI_TOOL_BROKER_TOKEN", token);
    restoreEnv("SANDI_TURN_ID", turnId);
  }
}

async function withBroker(
  run: (
    target: AttachTarget,
    setMode: (mode: ServerMode) => void,
    lastAuth: () => string | undefined,
    lastBody: () => unknown,
  ) => Promise<void>,
): Promise<void> {
  let mode: ServerMode = { kind: "accepted" };
  let auth: string | undefined;
  let body: unknown;
  const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);
  const server = createServer((request, response) => {
    auth = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : undefined;
      if (mode.kind === "accepted") {
        respond(response, 202, { ok: true });
      } else {
        respond(response, mode.status, { error: "broker_error" });
      }
    });
  });
  const url = await listen(server);
  try {
    await run(
      { url, token, turnId: "turn-x" },
      (next) => {
        mode = next;
      },
      () => auth,
      () => body,
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
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
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

await verifyAttachToReply();
