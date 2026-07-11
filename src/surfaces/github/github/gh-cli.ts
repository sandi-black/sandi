import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { z } from "zod/v4";
import {
  spawnCommandIgnoringStdin,
  spawnCommandWithPipeStdin,
} from "@/lib/provider/spawn-command";

const DEFAULT_ACCEPT = "application/vnd.github+json";
const DEFAULT_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

export type GitHubApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type GhCliOptions = {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type GhApiJsonInput<T> = {
  method?: GitHubApiMethod;
  endpoint: string;
  schema: z.ZodType<T>;
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
};

export type GhApiTextInput = {
  method?: GitHubApiMethod;
  endpoint: string;
  body?: unknown;
  accept?: string;
  paginate?: boolean;
  signal?: AbortSignal;
};

export type GhApiPaginatedJsonInput<T> = {
  endpoint: string;
  pageSchema: z.ZodType<T[]>;
  accept?: string;
  signal?: AbortSignal;
};

export class GhCliError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: {
    command: string;
    exitCode: number | null;
    stderr: string;
  }) {
    super(
      `${input.command} failed${input.exitCode === null ? "" : ` with exit code ${input.exitCode}`}: ${input.stderr.trim()}`,
    );
    this.name = "GhCliError";
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
  }
}

export class GhCli {
  readonly #command: string;
  readonly #cwd: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;

  constructor(options: GhCliOptions) {
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#env = options.env ?? process.env;
    this.#timeoutMs = positiveInteger(
      options.timeoutMs,
      readTimeoutMs(),
      "timeoutMs",
    );
    this.#maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      "maxStdoutBytes",
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    );
  }

  async apiJson<T>(input: GhApiJsonInput<T>): Promise<T> {
    const text = await this.apiText(input);
    return input.schema.parse(JSON.parse(text));
  }

  async apiJsonPages<T>(input: GhApiPaginatedJsonInput<T>): Promise<T[]> {
    const request: GhApiTextInput = {
      endpoint: input.endpoint,
      paginate: true,
    };
    if (input.accept) request.accept = input.accept;
    if (input.signal) request.signal = input.signal;
    const text = await this.apiText(request);
    const pages = z.array(input.pageSchema).parse(JSON.parse(text));
    return pages.flat();
  }

  async apiText(input: GhApiTextInput): Promise<string> {
    if (input.signal?.aborted) {
      throw abortError(this.#command, input.signal);
    }
    const method = input.method ?? "GET";
    const args = [
      "api",
      "--method",
      method,
      "-H",
      `Accept: ${input.accept ?? DEFAULT_ACCEPT}`,
      "-H",
      `X-GitHub-Api-Version: ${DEFAULT_API_VERSION}`,
    ];
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined) {
      args.push("--input", "-");
    }
    if (input.paginate) {
      args.push("--paginate", "--slurp");
    }
    args.push(apiEndpoint(input.endpoint));
    const result = await runCommand({
      command: this.#command,
      args,
      cwd: this.#cwd,
      env: this.#env,
      stdin: body,
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: this.#maxStdoutBytes,
      maxStderrBytes: this.#maxStderrBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return result.stdout;
  }
}

function apiEndpoint(endpoint: string): string {
  if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    return endpoint;
  }
  const url = new URL(endpoint);
  if (url.hostname !== "api.github.com") return endpoint;
  return `${url.pathname}${url.search}`;
}

type CommandInput = {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdin?: string | undefined;
  signal?: AbortSignal;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

type GhChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

function runCommand(input: CommandInput): Promise<CommandOutput> {
  const command = `${input.command} ${input.args.join(" ")}`;
  if (input.signal?.aborted) {
    return Promise.reject(abortError(command, input.signal));
  }

  return new Promise((resolveRun, rejectRun) => {
    const options = {
      env: input.env,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    let child: GhChild;
    try {
      child = spawnGhCommand(input, options);
    } catch (error) {
      rejectRun(error);
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      callback: () => void,
      options: { clearForceKillTimer?: boolean } = {},
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.clearForceKillTimer !== false && forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timeoutError = (): GhCliError =>
      new GhCliError({
        command,
        exitCode: null,
        stderr: `timed out after ${input.timeoutMs}ms`,
      });

    const terminate = (error: Error): void => {
      if (settled || terminating) return;
      terminating = true;
      signalProcessTree(child, "SIGTERM");
      // Keep Windows pipes alive until taskkill has enumerated the descendants
      // below cmd.exe. Closing them first can make the root exit and strand a
      // child before /T captures the tree.
      if (process.platform !== "win32") {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin?.destroy();
      }
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        forceKillTimer = undefined;
      }, FORCE_KILL_TIMEOUT_MS);
      finish(() => rejectRun(error), { clearForceKillTimer: false });
    };
    const onAbort = (): void => {
      const signal = input.signal;
      if (signal) terminate(abortError(command, signal));
    };
    const outputLimitError = (
      stream: "stdout" | "stderr",
      limit: number,
    ): GhCliError =>
      new GhCliError({
        command,
        exitCode: null,
        stderr: `${stream} exceeded ${limit} byte limit`,
      });

    child.stdout.on("data", (chunk: Buffer) => {
      if (terminating) return;
      if (stdoutBytes + chunk.byteLength > input.maxStdoutBytes) {
        terminate(outputLimitError("stdout", input.maxStdoutBytes));
        return;
      }
      stdoutBytes += chunk.byteLength;
      const decoded = stdoutDecoder.write(chunk);
      if (decoded) stdout.push(decoded);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminating) return;
      if (stderrBytes + chunk.byteLength > input.maxStderrBytes) {
        terminate(outputLimitError("stderr", input.maxStderrBytes));
        return;
      }
      stderrBytes += chunk.byteLength;
      const decoded = stderrDecoder.write(chunk);
      if (decoded) stderr.push(decoded);
    });
    child.stdout.on("error", (error) => {
      terminate(
        new GhCliError({
          command,
          exitCode: null,
          stderr: `stdout failed: ${errorMessage(error)}`,
        }),
      );
    });
    child.stderr.on("error", (error) => {
      terminate(
        new GhCliError({
          command,
          exitCode: null,
          stderr: `stderr failed: ${errorMessage(error)}`,
        }),
      );
    });

    child.on("error", (error) => {
      finish(() => rejectRun(error));
    });
    child.on("close", (exitCode) => {
      if (terminating) {
        if (forceKillTimer && processTreeIsGone(child)) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        return;
      }
      const stdoutEnd = stdoutDecoder.end();
      if (stdoutEnd) stdout.push(stdoutEnd);
      const stderrEnd = stderrDecoder.end();
      if (stderrEnd) stderr.push(stderrEnd);
      const output = {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      };
      if (exitCode === 0) {
        finish(() => resolveRun(output));
        return;
      }
      finish(() =>
        rejectRun(
          new GhCliError({
            command,
            exitCode,
            stderr: output.stderr || output.stdout,
          }),
        ),
      );
    });

    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", (error) => {
        terminate(
          new GhCliError({
            command,
            exitCode: null,
            stderr: `stdin failed: ${errorMessage(error)}`,
          }),
        );
      });
    }

    timeoutTimer = setTimeout(() => terminate(timeoutError()), input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    if (input.stdin !== undefined) {
      if (!stdin) {
        terminate(
          new GhCliError({
            command,
            exitCode: null,
            stderr: "stdin pipe was not available",
          }),
        );
        return;
      }
      try {
        stdin.end(input.stdin);
      } catch (error) {
        terminate(
          new GhCliError({
            command,
            exitCode: null,
            stderr: `stdin failed: ${errorMessage(error)}`,
          }),
        );
      }
    }
  });
}

function spawnGhCommand(
  input: CommandInput,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): GhChild {
  if (process.platform === "win32") {
    return input.stdin === undefined
      ? spawnCommandIgnoringStdin(input.command, input.args, options)
      : spawnCommandWithPipeStdin(input.command, input.args, options);
  }
  if (input.stdin === undefined) {
    return spawn(input.command, input.args, {
      ...options,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(input.command, input.args, {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function signalProcessTree(
  child: GhChild,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no catchable SIGTERM for a console process tree. A soft
    // taskkill can remove cmd.exe while leaving gh behind, so /T and /F must
    // be one atomic tree operation.
    const args = ["/PID", String(pid), "/T", "/F"];
    const killer = spawn("taskkill.exe", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      child.kill(signal);
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processTreeIsGone(child: GhChild): boolean {
  const pid = child.pid;
  if (pid === undefined) return true;
  // taskkill /T already addressed the full tree. Once the root closes, its PID
  // is no longer a safe tree handle and may be reused by an unrelated process.
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

function abortError(command: string, signal: AbortSignal): GhCliError {
  const reason =
    signal.reason instanceof Error &&
    signal.reason.name !== "AbortError" &&
    signal.reason.message
      ? `: ${signal.reason.message}`
      : "";
  return new GhCliError({
    command,
    exitCode: null,
    stderr: `aborted${reason}`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function readTimeoutMs(): number {
  const raw = process.env["SANDI_GH_TIMEOUT_MS"]?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}
