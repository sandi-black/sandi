import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type SpawnCommandOptions = {
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

export function spawnCommandWithPipeStdin(
  command: string,
  args: readonly string[],
  options: SpawnCommandOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const request = commandRequest(command, args);
  if (options.cwd) {
    return spawn(request.command, request.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
      windowsVerbatimArguments: process.platform === "win32",
    });
  }
  return spawn(request.command, request.args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
    windowsVerbatimArguments: process.platform === "win32",
  });
}

export function spawnCommandIgnoringStdin(
  command: string,
  args: readonly string[],
  options: SpawnCommandOptions,
): ChildProcessByStdio<null, Readable, Readable> {
  const request = commandRequest(command, args);
  if (options.cwd) {
    return spawn(request.command, request.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
      windowsVerbatimArguments: process.platform === "win32",
    });
  }
  return spawn(request.command, request.args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
    windowsVerbatimArguments: process.platform === "win32",
  });
}

function commandRequest(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args: [...args] };
  }
  return {
    command: process.env["ComSpec"]?.trim() || "cmd.exe",
    args: ["/d", "/c", windowsCommandLine(command, args)],
  };
}

function windowsCommandLine(command: string, args: readonly string[]): string {
  return [
    "call",
    quoteWindowsCommandName(command),
    ...args.map(quoteWindowsCommandPart),
  ].join(" ");
}

function quoteWindowsCommandName(value: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  return quoteWindowsCommandPart(value);
}

function quoteWindowsCommandPart(value: string): string {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("^", "^^")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>")
    .replaceAll('"', '\\"')}"`;
}
