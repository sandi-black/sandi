import { createServer, type Server, type ServerResponse } from "node:http";

import { errorMessage } from "@/lib/errors";
import { assert, assertEqual } from "@/lib/verification/harness";
import {
  resolveBooleanFlag,
  resolveConversationId,
} from "@/surfaces/api/client/chat";
import { postJson } from "@/surfaces/api/client/http";
import { createResponsePrinter } from "@/surfaces/api/client/response-printer";
import { reconcileSuffix, sendTurn } from "@/surfaces/api/client/turns";
import type { ResponseChunk } from "@/surfaces/api/devices/protocol";

// Covers the chat REPL's building blocks: how the CLI flags resolve, how a
// settled turn reconciles against the live stream, how the printer renders
// deltas, and how sendTurn maps server responses to outcomes.

const TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Reply = { status: number; body: unknown };

async function verifyTurns(): Promise<void> {
  verifyChatFlags();
  verifyReconcile();
  verifyPrinter();
  await verifySendTurn();
  await verifyHttpBounds();
  console.log("turns verification passed");
}

function verifyChatFlags(): void {
  // An absent --conversation mints a fresh, valid segment id.
  const minted = resolveConversationId(undefined);
  assert(
    typeof minted === "string" && minted.startsWith("desktop-"),
    "an absent --conversation mints a desktop-* id",
  );
  assertEqual(
    resolveConversationId("project-x"),
    "project-x",
    "a valid --conversation passes through unchanged",
  );
  assertEqual(
    resolveConversationId("has spaces"),
    undefined,
    "a --conversation outside the segment alphabet is rejected",
  );
  assertEqual(
    resolveConversationId("a/b"),
    undefined,
    "a --conversation with a path separator is rejected",
  );

  assertEqual(
    resolveBooleanFlag(undefined),
    false,
    "an absent boolean flag is false",
  );
  assertEqual(
    resolveBooleanFlag("true"),
    true,
    "a bare flag (recorded as 'true') is true",
  );
  assertEqual(
    resolveBooleanFlag("false"),
    false,
    "an explicit false value is false",
  );
  assertEqual(resolveBooleanFlag("off"), false, "off is false");
  assertEqual(resolveBooleanFlag("1"), true, "any other value is true");
  console.log("ok the chat flags resolve to a valid id and a boolean");
}

function verifyReconcile(): void {
  assertEqual(
    reconcileSuffix("", "hello"),
    "hello",
    "nothing streamed: print all",
  );
  assertEqual(
    reconcileSuffix("hel", "hello"),
    "lo",
    "final extends stream: suffix",
  );
  assertEqual(
    reconcileSuffix("hello", "hello"),
    "",
    "exact match: nothing left",
  );
  assertEqual(
    reconcileSuffix("hello\n", "hello"),
    "",
    "stream ran ahead with trailing whitespace: nothing left",
  );
  assertEqual(
    reconcileSuffix(" hello", "hello "),
    "",
    "only whitespace differs: nothing left",
  );
  assertEqual(
    reconcileSuffix("xyz", "hello"),
    "\nhello",
    "diverged: fall back to the final on a fresh line",
  );
  console.log("ok reconcileSuffix fills only the missing tail");
}

function verifyPrinter(): void {
  // A normal stream: deltas print, the settle adds nothing but the newline.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "text", "Hel"));
      printer.onChunk(delta("t1", 1, "text", "lo"));
      printer.settle("Hello");
    }),
    "Hello\n",
    "a streamed answer prints once and ends with a newline",
  );

  // Streaming missing entirely: the settle prints the whole final text.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.settle("Hi there");
    }),
    "Hi there\n",
    "with no live stream the final text is printed in full",
  );

  // The child exited before its last delta: settle fills the tail.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "text", "Hel"));
      printer.settle("Hello");
    }),
    "Hello\n",
    "a missing tail is filled from the final text",
  );

  // A straggler from another turn is ignored, even as the first delta seen.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t2", 0, "text", "OLD"));
      printer.onChunk(delta("t1", 0, "text", "A"));
      printer.settle("A");
    }),
    "A\n",
    "a delta from a different turn does not bleed in",
  );

  // A lost delta (a seq gap) abandons the live preview; settle prints the full
  // authoritative final on a fresh line rather than a corrupted partial.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "text", "Hel"));
      printer.onChunk(delta("t1", 2, "text", "!!")); // seq 1 was lost
      printer.settle("Hello");
    }),
    "Hel\nHello\n",
    "a seq gap falls back to the authoritative final",
  );

  // A duplicated delta is rendered once.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "text", "A"));
      printer.onChunk(delta("t1", 0, "text", "A"));
      printer.settle("A");
    }),
    "A\n",
    "a duplicate delta is not rendered twice",
  );

  // Thinking is suppressed by default and shown (dimmed) when asked.
  assertEqual(
    render((printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "thinking", "psst"));
      printer.onChunk(delta("t1", 1, "text", "Hi"));
      printer.settle("Hi");
    }),
    "Hi\n",
    "thinking is suppressed by default",
  );
  const withThinking = render(
    (printer) => {
      printer.begin("t1");
      printer.onChunk(delta("t1", 0, "thinking", "psst"));
      printer.onChunk(delta("t1", 1, "text", "Hi"));
      printer.settle("Hi");
    },
    { showThinking: true },
  );
  assert(
    withThinking.includes("psst") && withThinking.endsWith("Hi\n"),
    "thinking is shown when enabled",
  );
  console.log(
    "ok the response printer streams, reconciles, and gates thinking",
  );
}

async function verifySendTurn(): Promise<void> {
  await withServer(
    { status: 200, body: { conversationId: "c1", text: "the answer" } },
    async (url) => {
      const outcome = await sendTurn({
        url,
        token: TOKEN,
        conversationId: "c1",
        input: "hi",
      });
      assert(
        outcome.ok && outcome.text === "the answer",
        "a 200 returns the final response text",
      );
      console.log("ok a completed turn returns the final text");
    },
  );

  await assertTurnError(
    { status: 401, body: { error: "unauthorized" } },
    "re-pair",
    "a 401 explains the token was rejected",
  );
  await assertTurnError(
    { status: 500, body: { error: "internal_error" } },
    "status 500",
    "an unexpected status surfaces the status",
  );

  const unreachable = await sendTurn({
    url: "http://127.0.0.1:1",
    token: TOKEN,
    conversationId: "c1",
    input: "hi",
  });
  assert(
    !unreachable.ok && unreachable.error.includes("could not reach"),
    "an unreachable server reports a reachability error",
  );
  console.log("ok sendTurn maps server replies to outcomes");
}

async function verifyHttpBounds(): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/drip") {
      response.writeHead(200, { "content-type": "application/json" });
      const drip = setInterval(() => response.write(" "), 10);
      response.on("close", () => clearInterval(drip));
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(4_096));
      return;
    }
    response.writeHead(404).end();
  });
  const url = await listen(server);
  try {
    const timeoutError = await rejectionMessageWithin(
      postJson({
        url,
        path: "/drip",
        body: {},
        timeoutMs: 75,
      }),
      1_000,
    );
    assert(
      timeoutError.includes("timed out after 75ms"),
      `an active slow-drip response hits the total deadline (got ${timeoutError})`,
    );

    const sizeError = await rejectionMessageWithin(
      postJson({
        url,
        path: "/large",
        body: {},
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
      1_000,
    );
    assert(
      sizeError.includes("response exceeded 1024 bytes"),
      `an oversized response is rejected at its byte cap (got ${sizeError})`,
    );
    console.log("ok postJson bounds total time and response bytes");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
}

async function rejectionMessageWithin(
  promise: Promise<unknown>,
  guardMs: number,
): Promise<string> {
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    guardTimer = setTimeout(
      () => reject(new Error(`request did not settle within ${guardMs}ms`)),
      guardMs,
    );
  });
  try {
    await Promise.race([promise, guard]);
    return "request unexpectedly resolved";
  } catch (error) {
    return errorMessage(error);
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}

function delta(
  turnId: string,
  seq: number,
  channel: "text" | "thinking",
  text: string,
): ResponseChunk {
  return { type: "delta", turnId, seq, channel, delta: text };
}

function render(
  run: (printer: ReturnType<typeof createResponsePrinter>) => void,
  options?: { showThinking?: boolean },
): string {
  let out = "";
  const printer = createResponsePrinter({
    write: (text) => {
      out += text;
    },
    ...(options?.showThinking ? { showThinking: true } : {}),
  });
  run(printer);
  return out;
}

async function assertTurnError(
  reply: Reply,
  needle: string,
  label: string,
): Promise<void> {
  await withServer(reply, async (url) => {
    const outcome = await sendTurn({
      url,
      token: TOKEN,
      conversationId: "c1",
      input: "hi",
    });
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
    if (!/^\/v1\/conversations\/[^/]+\/turns$/.test(request.url ?? "")) {
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
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
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
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolveListen(`http://127.0.0.1:${port}`);
    });
  });
}

await verifyTurns();
