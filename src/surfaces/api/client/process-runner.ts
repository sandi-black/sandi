import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const KILL_GRACE_MS = 2_000;
const KILL_SETTLEMENT_GRACE_MS = 1_000;

export type ProcessRunResult = {
  kind: "completed" | "timed_out" | "cancelled" | "spawn_error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
};

/**
 * Owns the complete lifecycle of one bounded child process so every local
 * scripting runtime gets the same cancellation and descendant-cleanup rules.
 */
export function runBoundedProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}): Promise<ProcessRunResult> {
  if (input.signal?.aborted) {
    return Promise.resolve(emptyResult("cancelled", 0));
  }
  const startedAt = Date.now();
  return new Promise((resolveRun) => {
    const options: SpawnOptionsWithoutStdio = {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: input.env,
      shell: false,
      windowsHide: true,
    };
    const child = spawn(input.executable, [...input.args], options);
    const stdout = createBoundedCapture(input.maxOutputChars);
    const stderr = createBoundedCapture(input.maxOutputChars);
    let kind: ProcessRunResult["kind"] = "completed";
    let settled = false;
    let terminationStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settlementBackstop: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (settlementBackstop) clearTimeout(settlementBackstop);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const result = (
      exitCode: number | null,
      childSignal: NodeJS.Signals | null,
      error?: string,
    ): ProcessRunResult => {
      const out = stdout.finish();
      const err = stderr.finish();
      return {
        kind,
        exitCode,
        signal: childSignal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - startedAt,
        ...(error !== undefined ? { error } : {}),
      };
    };
    const settle = (value: ProcessRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRun(value);
    };
    const terminate = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      killProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
        settlementBackstop = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle(result(null, null));
        }, KILL_SETTLEMENT_GRACE_MS);
      }, KILL_GRACE_MS);
    };
    function onAbort(): void {
      kind = "cancelled";
      terminate();
    }

    timer = setTimeout(() => {
      kind = "timed_out";
      terminate();
    }, input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => {
      kind = "spawn_error";
      settle(result(null, null, error.message));
    });
    child.on("close", (code, childSignal) => {
      settle(result(code, childSignal));
    });
  });
}

type BoundedCapture = {
  append(chunk: Buffer): void;
  finish(): { text: string; truncated: boolean };
};

function createBoundedCapture(maxChars: number): BoundedCapture {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let truncated = false;
  let finished = false;
  const appendText = (value: string): void => {
    const available = Math.max(0, maxChars - text.length);
    text += value.slice(0, available);
    if (value.length > available) truncated = true;
  };
  return {
    append(chunk): void {
      if (!finished) appendText(decoder.write(chunk));
    },
    finish(): { text: string; truncated: boolean } {
      if (!finished) {
        finished = true;
        appendText(decoder.end());
      }
      return { text: text.trimEnd(), truncated };
    },
  };
}

function emptyResult(
  kind: ProcessRunResult["kind"],
  durationMs: number,
): ProcessRunResult {
  return {
    kind,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs,
  };
}

function killProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid === undefined) {
    killDirectly(child, signal);
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    let fellBack = false;
    const fallback = (): void => {
      if (fellBack) return;
      fellBack = true;
      killDirectly(child, signal);
    };
    killer.once("error", fallback);
    killer.once("exit", (code, killerSignal) => {
      if (code !== 0 || killerSignal !== null) fallback();
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    killDirectly(child, signal);
  }
}

function killDirectly(
  child: ChildProcessWithoutNullStreams,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    child.kill(signal);
  } catch {
    // A concurrent close means the requested outcome is already satisfied.
  }
}
