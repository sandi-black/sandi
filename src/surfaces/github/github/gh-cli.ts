import { z } from "zod/v4";
import {
  spawnCommandIgnoringStdin,
  spawnCommandWithPipeStdin,
} from "@/lib/provider/spawn-command";

const DEFAULT_ACCEPT = "application/vnd.github+json";
const DEFAULT_API_VERSION = "2022-11-28";

export type GitHubApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type GhCliOptions = {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type GhApiJsonInput<T> = {
  method?: GitHubApiMethod;
  endpoint: string;
  schema: z.ZodType<T>;
  body?: unknown;
  accept?: string;
};

export type GhApiTextInput = {
  method?: GitHubApiMethod;
  endpoint: string;
  body?: unknown;
  accept?: string;
  paginate?: boolean;
};

export type GhApiPaginatedJsonInput<T> = {
  endpoint: string;
  pageSchema: z.ZodType<T[]>;
  accept?: string;
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

  constructor(options: GhCliOptions) {
    this.#command = options.command;
    this.#cwd = options.cwd;
    this.#env = options.env ?? process.env;
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
    const text = await this.apiText(request);
    const pages = z.array(input.pageSchema).parse(JSON.parse(text));
    return pages.flat();
  }

  async apiText(input: GhApiTextInput): Promise<string> {
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
  stdin?: string | undefined;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

function runCommand(input: CommandInput): Promise<CommandOutput> {
  return new Promise((resolveRun, rejectRun) => {
    const options = {
      env: input.env,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const child =
      input.stdin === undefined
        ? spawnCommandIgnoringStdin(input.command, input.args, options)
        : spawnCommandWithPipeStdin(input.command, input.args, options);
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => rejectRun(error));
    child.on("close", (exitCode) => {
      const output = {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      };
      if (exitCode === 0) {
        resolveRun(output);
        return;
      }
      rejectRun(
        new GhCliError({
          command: `${input.command} ${input.args.join(" ")}`,
          exitCode,
          stderr: output.stderr || output.stdout,
        }),
      );
    });

    if (input.stdin !== undefined) {
      const stdin = child.stdin;
      if (!stdin) {
        rejectRun(new Error("gh command stdin pipe was not available"));
        return;
      }
      stdin.end(input.stdin);
    }
  });
}
