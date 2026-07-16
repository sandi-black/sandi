import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import spawn from "cross-spawn";

import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class ExactStdioTransport implements Transport {
  private child: ChildProcess | undefined;
  private closing: Promise<void> | undefined;
  private buffer = Buffer.alloc(0);
  readonly stderr = new PassThrough();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly command: {
      executable: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
    },
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    if (this.child) throw new Error("desktop MCP transport is already started");
    return new Promise((resolve, reject) => {
      const child = spawn(this.command.executable, this.command.args, {
        ...(this.command.cwd !== undefined ? { cwd: this.command.cwd } : {}),
        env: this.command.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const { stdin, stdout, stderr } = child;
      if (!stdin || !stdout || !stderr) {
        child.kill();
        reject(new Error("desktop MCP transport did not open stdio pipes"));
        return;
      }
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.fail(error);
      });
      child.once("spawn", resolve);
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
        this.onclose?.();
      });
      stdin.on("error", (error) => this.fail(error));
      stdout.on("error", (error) => this.fail(error));
      stdout.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > 8 * 1024 * 1024) {
          const error = new Error("desktop MCP stdout frame exceeded 8 MiB");
          this.fail(error);
          return;
        }
        this.drainMessages();
      });
      stderr.on("error", (error) => this.fail(error));
      stderr.pipe(this.stderr, { end: false });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    const closing = this.closeChild(child);
    this.closing = closing;
    return closing.then(
      () => {
        if (this.child === child) this.child = undefined;
        if (this.closing === closing) this.closing = undefined;
        this.buffer = Buffer.alloc(0);
      },
      (error: unknown) => {
        if (this.closing === closing) this.closing = undefined;
        return Promise.reject(error);
      },
    );
  }

  private async closeChild(child: ChildProcess): Promise<void> {
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    child.stdin?.end();
    await Promise.race([closed, delay(2_000)]);
    if (!hasExited(child)) child.kill("SIGTERM");
    await Promise.race([closed, delay(2_000)]);
    if (!hasExited(child)) child.kill("SIGKILL");
    if (!hasExited(child)) await closed;
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child)
      return Promise.reject(new Error("desktop MCP is not connected"));
    return new Promise((resolve, reject) => {
      const payload = serializeMessage(message);
      if (!child.stdin) {
        reject(new Error("desktop MCP stdin is unavailable"));
        return;
      }
      child.stdin.write(payload, (error) => {
        if (!error) {
          resolve();
          return;
        }
        this.fail(error);
        reject(error);
      });
    });
  }

  private drainMessages(): void {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private fail(error: Error): void {
    this.onerror?.(error);
    void this.close().catch((closeError: unknown) => {
      this.onerror?.(
        closeError instanceof Error
          ? closeError
          : new Error(String(closeError)),
      );
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
