import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import type { DesktopCredentials } from "@/surfaces/api/client/credentials";
import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import { createResponsePrinter } from "@/surfaces/api/client/response-printer";
import { sendTurn } from "@/surfaces/api/client/turns";

// The interactive chat REPL behind `npm run client -- chat`. It holds the device
// link in the background (so tool calls still run locally), reads a line at a
// time from stdin, sends each as a turn, and prints the response as it streams
// over the link. index.ts parses the flags and hands the resolved settings here
// so the CLI entrypoint stays a thin dispatcher.

export type ChatReplOptions = {
  credentials: DesktopCredentials;
  // Where the desktop's local tool calls resolve their paths.
  rootDir: string;
  // The conversation the turns belong to, so context carries across lines.
  conversationId: string;
  // Render the model's thinking (dimmed) alongside the answer.
  showThinking: boolean;
};

// How long to wait for the device link to come up before showing the first
// prompt. The turn still works if the link is slow; it just will not show a live
// preview until the link is established.
const LINK_WAIT_MS = 5_000;

export async function runChatRepl(options: ChatReplOptions): Promise<void> {
  const { credentials, rootDir, conversationId, showThinking } = options;

  const controller = new AbortController();
  const printer = createResponsePrinter({
    write: (text) => process.stdout.write(text),
    showThinking,
  });

  // The link carries both tool calls and the streamed response deltas. Run it in
  // the background and note when it first comes up so the first turn can stream.
  let markLinked: (() => void) | undefined;
  const linked = new Promise<void>((resolveLinked) => {
    markLinked = resolveLinked;
  });
  const link = runDesktopClient({
    credentials,
    rootDir,
    signal: controller.signal,
    onStatus: (message) => {
      if (message === "linked") markLinked?.();
      // Status lines go to stderr so stdout stays the conversation alone.
      process.stderr.write(`[sandi] ${message}\n`);
    },
    onResponseChunk: (chunk) => printer.onChunk(chunk),
  }).catch((error: unknown) => {
    process.stderr.write(
      `[sandi] link error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  await Promise.race([linked, delay(LINK_WAIT_MS)]);

  process.stdout.write(
    `Chatting with sandi as device ${credentials.deviceId} (conversation ${conversationId}).\n` +
      "Type a message and press enter. Ctrl-D or /exit to quit.\n\n",
  );

  const rl = createInterface({ input: process.stdin });
  process.once("SIGINT", () => {
    controller.abort();
    rl.close();
  });

  process.stdout.write("you> ");
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === "") {
      process.stdout.write("you> ");
      continue;
    }
    if (line === "/exit" || line === "/quit") break;
    // Mint the turn id here so the printer can bind its live preview to this
    // exact turn and ignore any straggling delta from the previous one.
    const turnId = randomUUID();
    printer.begin(turnId);
    process.stdout.write("sandi> ");
    const outcome = await sendTurn({
      url: credentials.url,
      token: credentials.token,
      conversationId,
      input: line,
      turnId,
      signal: controller.signal,
    });
    if (outcome.ok) {
      printer.settle(outcome.text);
    } else {
      process.stdout.write("\n");
      process.stderr.write(`[sandi] ${outcome.error}\n`);
    }
    process.stdout.write("\nyou> ");
  }

  rl.close();
  controller.abort();
  await link;
  process.stdout.write("\nchat ended\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}
