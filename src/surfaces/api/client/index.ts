import { resolve } from "node:path";

import {
  desktopConfigPath,
  loadDesktopCredentials,
  saveDesktopCredentials,
} from "@/surfaces/api/client/credentials";
import { runDesktopClient } from "@/surfaces/api/client/desktop-client";
import { pairDesktop } from "@/surfaces/api/client/pairing";

// Reference desktop client. Two commands:
//
//   pair <CODE> [--url URL] [--label LABEL]   redeem a /sandi auth code, store a token
//   run [--root DIR] [--url URL]              hold the link and run tool calls locally
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
  const url =
    flags.options["url"] ?? process.env["SANDI_API_URL"] ?? DEFAULT_URL;
  const label = flags.options["label"];
  const outcome = await pairDesktop({
    url,
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
  const path = desktopConfigPath();
  const credentials = await loadDesktopCredentials(path);
  if (!credentials) {
    console.error(
      `no saved credentials at ${path}; run \`pair <CODE>\` with a /sandi auth code first`,
    );
    process.exitCode = 1;
    return;
  }
  const url = flags.options["url"];
  const effective = url ? { ...credentials, url } : credentials;
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
      "",
      `Credentials are stored at ${desktopConfigPath()}`,
      "(override with the SANDI_DESKTOP_CONFIG environment variable).",
    ].join("\n"),
  );
}
