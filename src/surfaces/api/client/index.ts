import { hostname } from "node:os";
import { resolve } from "node:path";

import {
  resolveBooleanFlag,
  resolveConversationId,
  runChatRepl,
} from "@/surfaces/api/client/chat";
import {
  type DesktopCredentials,
  desktopConfigPath,
  loadDesktopCredentials,
  migrateLegacyDesktopConfig,
  parseLoginCredentials,
  ServerUrlSchema,
  saveDesktopCredentials,
} from "@/surfaces/api/client/credentials";
import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import { pairDesktop } from "@/surfaces/api/client/pairing";

// Reference desktop client. Four commands:
//
//   pair <CODE> [--url URL] [--label LABEL]   redeem a /sandi auth code, store a token
//   login --token T [--url URL] [...]         store a token issued by `api:enroll`
//   run [--root DIR] [--url URL]              hold the link and run tool calls locally
//   chat [--root DIR] [--url URL] [...]       interactive REPL with a streamed response
//
// `run` is the default when no command is given. `pair` and `login` both write
// the credentials file: `pair` for the Discord self-service flow, `login` for an
// operator-minted token. The file lives in the OS config dir (%APPDATA%\sandi on
// Windows, ~/Library/Application Support/sandi on macOS, ~/.config/sandi on
// Linux); override the whole path with SANDI_DESKTOP_CONFIG.

const DEFAULT_URL = "http://127.0.0.1:8787";

await main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "run";
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  // Carry an existing ~/.sandi/desktop.json forward to the OS config dir before
  // any command reads or writes it, so the move is invisible to a paired user.
  const moved = await migrateLegacyDesktopConfig();
  if (moved) console.log(`Moved your saved credentials to ${moved}.`);
  if (command === "pair") {
    await pairCommand(args.slice(1));
    return;
  }
  if (command === "login") {
    await loginCommand(args.slice(1));
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

// Stores a token minted out of band by `npm run api:enroll` (the operator path),
// so a self-hosted user does not have to hand-write the credentials file. The
// server derives the identity and device from the token, so --identity and
// --device here are only labels the client shows; they default sensibly.
async function loginCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const token = flags.options["token"]?.trim();
  if (!token) {
    console.error(
      "usage: login --token <TOKEN> [--url URL] [--identity ID] [--device ID]",
    );
    process.exitCode = 1;
    return;
  }
  // Validate the whole credential set in one pass through the same schema the
  // file is read back with, so a mistyped token or url is rejected here (not as a
  // late 401) without revalidating the url twice.
  const parsed = parseLoginCredentials({
    url: flags.options["url"] ?? process.env["SANDI_API_URL"] ?? DEFAULT_URL,
    token,
    identityId: flags.options["identity"] ?? "self",
    deviceId: flags.options["device"] ?? defaultDeviceLabel(),
  });
  if (!parsed.ok) {
    console.error(
      `could not store credentials (${parsed.field}): ${parsed.message}`,
    );
    process.exitCode = 1;
    return;
  }
  const { credentials } = parsed;
  const path = desktopConfigPath();
  await saveDesktopCredentials(path, credentials);
  console.log(`Saved credentials to ${path}.`);
  console.log(
    `Linked to ${credentials.url} as device ${credentials.deviceId} (identity ${credentials.identityId}).`,
  );
  console.log("Start chatting with: npm run client -- chat");
}

// A readable default for the stored device label: the machine's hostname,
// reduced to the credential segment alphabet, or "desktop" when the host name
// yields nothing usable.
function defaultDeviceLabel(): string {
  const sanitized = hostname()
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "desktop";
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

async function chatCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const effective = await loadEffectiveCredentials(flags);
  if (!effective) return;
  const rootDir = resolve(flags.options["root"] ?? process.cwd());
  // Parse the two free-form chat flags at the CLI boundary so a bad value is
  // rejected here rather than sent to the server or silently misread.
  const conversationId = resolveConversationId(flags.options["conversation"]);
  if (conversationId === undefined) {
    console.error(
      "invalid --conversation: use letters, digits, '.', '_', or '-' (max 200 chars)",
    );
    process.exitCode = 1;
    return;
  }
  const showThinking = resolveBooleanFlag(flags.options["thinking"]);
  await runChatRepl({
    credentials: effective,
    rootDir,
    conversationId,
    showThinking,
  });
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
      "  login --token T [--url URL]               store an api:enroll token directly",
      "        [--identity ID] [--device ID]",
      "  run [--root DIR] [--url URL]              hold the link and run tool calls locally",
      "  chat [--root DIR] [--url URL]             interactive REPL; the response streams in live",
      "       [--conversation ID] [--thinking]",
      "",
      `Credentials are stored at ${desktopConfigPath()}`,
      "(override with the SANDI_DESKTOP_CONFIG environment variable).",
    ].join("\n"),
  );
}
