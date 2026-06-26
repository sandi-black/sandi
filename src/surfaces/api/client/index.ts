import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  type DesktopCredentials,
  desktopConfigPath,
  loadDesktopCredentials,
  ServerUrlSchema,
  saveDesktopCredentials,
} from "@/surfaces/api/client/credentials";
import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import { pairDesktop } from "@/surfaces/api/client/pairing";
import { createResponsePrinter } from "@/surfaces/api/client/response-printer";
import { sendTurn } from "@/surfaces/api/client/turns";

// Reference desktop client. Three commands:
//
//   pair <CODE> [--url URL] [--label LABEL]   redeem a /sandi auth code, store a token
//   run [--root DIR] [--url URL]              hold the link and run tool calls locally
//   chat [--root DIR] [--url URL] [...]       interactive REPL with a streamed response
//
// `run` is the default when no command is given. The token and server URL are
// stored by `pair` under ~/.sandi/desktop.json (override with SANDI_DESKTOP_CONFIG).

const DEFAULT_URL = "http://127.0.0.1:8787";

await main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "run";
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "pair") {
    await pairCommand(args.slice(1));
    return;
  }
  if (command === "run") {
    await runCommand(args.slice(1));
    return;
  }
  if (command === "chat") {
    await chatCommand(args.slice(1));
    return;
  }
  // No recognized command: treat the whole arg list as `run` flags so a bare
  // invocation with only flags still works.
  if (command.startsWith("--")) {
    await runCommand(args);
    return;
  }
  console.error(`unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}

async function pairCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const code = flags.positionals[0];
  if (!code) {
    console.error("usage: pair <CODE> [--url URL] [--label LABEL]");
    process.exitCode = 1;
    return;
  }
  const rawUrl =
    flags.options["url"] ?? process.env["SANDI_API_URL"] ?? DEFAULT_URL;
  // Parse the url at this boundary so an invalid --url or SANDI_API_URL is
  // rejected before it reaches pairing or is written into saved credentials.
  const parsedUrl = ServerUrlSchema.safeParse(rawUrl);
  if (!parsedUrl.success) {
    console.error(`invalid server url: ${rawUrl} (must be an http(s) url)`);
    process.exitCode = 1;
    return;
  }
  const label = flags.options["label"];
  const outcome = await pairDesktop({
    url: parsedUrl.data,
    code,
    ...(label !== undefined ? { label } : {}),
  });
  if (!outcome.ok) {
    console.error(`pairing failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }
  const path = desktopConfigPath();
  await saveDesktopCredentials(path, outcome.credentials);
  console.log(
    `Paired as identity ${outcome.credentials.identityId} (device ${outcome.credentials.deviceId}).`,
  );
  console.log(`Saved credentials to ${path}.`);
  console.log("Start the client with: npm run client -- run");
}

async function runCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const effective = await loadEffectiveCredentials(flags);
  if (!effective) return;
  const rootDir = resolve(flags.options["root"] ?? process.cwd());

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(
    `Linking ${effective.url} as device ${effective.deviceId}; tool paths resolve under ${rootDir}.`,
  );
  await runDesktopClient({
    credentials: effective,
    rootDir,
    signal: controller.signal,
    onStatus: (message) => console.log(`[sandi] ${message}`),
  });
  console.log("client stopped");
}

// How long the chat REPL waits for the device link to come up before showing
// the first prompt. The turn still works if the link is slow; it just will not
// show a live preview until the link is established.
const LINK_WAIT_MS = 5_000;

async function chatCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const effective = await loadEffectiveCredentials(flags);
  if (!effective) return;
  const rootDir = resolve(flags.options["root"] ?? process.cwd());
  const conversationId =
    flags.options["conversation"] ?? `desktop-${randomUUID()}`;
  const showThinking = flags.options["thinking"] !== undefined;

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
    credentials: effective,
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
    `Chatting with sandi as device ${effective.deviceId} (conversation ${conversationId}).\n` +
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
      url: effective.url,
      token: effective.token,
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

// Loads saved credentials and applies a --url override through the same parser
// as the stored url, so both run and chat share one boundary. Returns undefined
// (after printing why and setting a failing exit code) when there are no
// credentials or the override is not an http(s) url.
async function loadEffectiveCredentials(flags: {
  options: Record<string, string>;
}): Promise<DesktopCredentials | undefined> {
  const path = desktopConfigPath();
  const credentials = await loadDesktopCredentials(path);
  if (!credentials) {
    console.error(
      `no saved credentials at ${path}; run \`pair <CODE>\` with a /sandi auth code first`,
    );
    process.exitCode = 1;
    return undefined;
  }
  const override = flags.options["url"];
  if (override === undefined) return credentials;
  const parsedOverride = ServerUrlSchema.safeParse(override);
  if (!parsedOverride.success) {
    console.error(
      `invalid --url override: ${override} (must be an http(s) url)`,
    );
    process.exitCode = 1;
    return undefined;
  }
  return { ...credentials, url: parsedOverride.data };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}

function parseFlags(args: string[]): {
  positionals: string[];
  options: Record<string, string>;
} {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = "true";
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

function printUsage(): void {
  console.log(
    [
      "Sandi desktop client",
      "",
      "Commands:",
      "  pair <CODE> [--url URL] [--label LABEL]   redeem a /sandi auth code and store a token",
      "  run [--root DIR] [--url URL]              hold the link and run tool calls locally",
      "  chat [--root DIR] [--url URL]             interactive REPL; the response streams in live",
      "       [--conversation ID] [--thinking]",
      "",
      `Credentials are stored at ${desktopConfigPath()}`,
      "(override with the SANDI_DESKTOP_CONFIG environment variable).",
    ].join("\n"),
  );
}
