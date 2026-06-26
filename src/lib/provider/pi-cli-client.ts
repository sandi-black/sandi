import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PiConfig } from "@/lib/config/env";
import type { MemoryContext } from "@/lib/context/memory";
import { participantMemoryRef } from "@/lib/identity/types";
import { createLogger } from "@/lib/logging";
import {
  type PiAccountCandidate,
  PiAccountRouter,
  type PiAccountRoutingRequest,
  type PiAccountConfig as PiExecutionAccount,
} from "@/lib/provider/pi-account-routing";
import {
  DELIVERY_SIDE_EFFECT_FILE_ENV,
  deliverySideEffectFileHasEntries,
} from "@/lib/provider/side-effects";
import { spawnCommandWithPipeStdin } from "@/lib/provider/spawn-command";
import type { SandiSurfaceContext } from "@/lib/surface-context";

const log = createLogger("provider");
const SYSTEM_PROMPT_FILE_NOTICE =
  "The authoritative Sandi system instructions are appended from a content-addressed file. Follow the appended instructions exactly.";

// Coordinates for a per-turn loopback tool broker. When present, the turn's pi
// child receives them in its environment and routes its proxy tool calls there.
// The api surface mints these per turn for a connected desktop; other surfaces
// never set them.
export type LocalToolBroker = {
  url: string;
  token: string;
};

export type ProviderTurnRequest = {
  conversationId: string;
  instructions: string;
  input: string;
  sessionMode?: "persistent" | "none";
  thinking?: string;
  timeoutMs?: number;
  platformContext?: Record<string, unknown>;
  accountRouting?: PiAccountRoutingRequest;
  surfaceContext?: SandiSurfaceContext;
  memoryContext: MemoryContext;
  localToolBroker?: LocalToolBroker;
  signal?: AbortSignal;
};

export type ProviderTurnResponse = {
  text: string;
  deliverySideEffects: boolean;
  raw: unknown;
};

export type ProviderFailureReason =
  | "aborted"
  | "quota-limit"
  | "rate-limit"
  | "timeout"
  | "unknown";

export class ProviderTurnError extends Error {
  readonly reason: ProviderFailureReason;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly deliverySideEffects: boolean;
  readonly accountId?: string;

  constructor(input: {
    message: string;
    reason: ProviderFailureReason;
    exitCode: number | null;
    stderr: string;
    deliverySideEffects?: boolean;
    accountId?: string;
  }) {
    super(input.message);
    this.name = "ProviderTurnError";
    this.reason = input.reason;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
    this.deliverySideEffects = input.deliverySideEffects ?? false;
    if (input.accountId) this.accountId = input.accountId;
  }
}

export type ProviderProbe = {
  command: ProbeResult;
  version: ProbeResult;
  model: ProbeResult;
};

export type ProbeResult = {
  ok: boolean;
  detail: string;
};

export interface ModelProviderClient {
  probe(): Promise<ProviderProbe>;
  generateTurn(request: ProviderTurnRequest): Promise<ProviderTurnResponse>;
}

export class PiCliClient implements ModelProviderClient {
  readonly #command: string;
  readonly #model: string | undefined;
  readonly #provider: string | undefined;
  readonly #thinking: string | undefined;
  readonly #agentDir: string | undefined;
  readonly #packageDir: string | undefined;
  readonly #sessionDir: string;
  readonly #tokenUsagePath: string;
  readonly #extensionPaths: string[];
  readonly #timeoutMs: number;
  readonly #eventsRoot: string;
  readonly #remindersRoot: string;
  readonly #feedbackRoot: string;
  readonly #skillsRoot: string;
  readonly #accountRouter: PiAccountRouter | undefined;

  constructor(config: PiConfig) {
    this.#command = config.command;
    this.#model = config.model;
    this.#provider = config.provider;
    this.#thinking = config.thinking;
    this.#agentDir = config.agentDir;
    this.#packageDir = config.packageDir;
    this.#sessionDir = config.sessionDir;
    this.#tokenUsagePath = config.tokenUsagePath;
    this.#extensionPaths = config.extensionPaths;
    this.#timeoutMs = config.timeoutMs;
    this.#eventsRoot = config.eventsRoot;
    this.#remindersRoot = config.remindersRoot;
    this.#feedbackRoot = config.feedbackRoot;
    this.#skillsRoot = config.skillsRoot;
    this.#accountRouter = config.accountRouting
      ? new PiAccountRouter(config.accountRouting)
      : undefined;
  }

  async probe(): Promise<ProviderProbe> {
    const command = await this.#run(["--help"], 5_000);
    const version = await this.#run(["--version"], 5_000);
    return {
      command: {
        ok: command.ok,
        detail: command.ok ? "pi command is available" : command.stderr,
      },
      version: {
        ok: version.ok,
        detail: version.stdout.trim() || version.stderr.trim() || "unknown",
      },
      model: {
        ok: true,
        detail: this.#model ?? "using pi default model/config",
      },
    };
  }

  async generateTurn(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    if (!this.#accountRouter) {
      return this.#generateTurnWithAccount(request, undefined);
    }

    const candidates = await this.#accountRouter.candidates(
      request.accountRouting,
    );
    if (candidates.length === 0) {
      throw new ProviderTurnError({
        message: "No configured Pi account is available for this route",
        reason: "unknown",
        exitCode: null,
        stderr:
          "No configured Pi account is available. Check each account's auth.json.",
      });
    }

    const candidate = candidates[0];
    if (!candidate) {
      throw new ProviderTurnError({
        message: "Pi account routing did not produce a provider response",
        reason: "unknown",
        exitCode: null,
        stderr: "Pi account routing exhausted candidates",
      });
    }

    return await this.#generateTurnWithAccount(request, candidate);
  }

  async #generateTurnWithAccount(
    request: ProviderTurnRequest,
    candidate: PiAccountCandidate | undefined,
  ): Promise<ProviderTurnResponse> {
    const account = candidate?.account;
    const args = ["--print"];
    for (const extensionPath of this.#extensionPaths) {
      args.push("--extension", extensionPath);
    }
    await mkdir(this.#sessionDir, { recursive: true });
    const systemPromptFile = await writeSystemPromptPayload(
      this.#sessionDir,
      request.instructions,
    );
    args.push("--system-prompt", SYSTEM_PROMPT_FILE_NOTICE);
    args.push("--append-system-prompt", systemPromptFile);
    if (request.sessionMode === "none") {
      args.push("--no-session");
    } else {
      const persistentSessionPath = sessionPath(
        this.#sessionDir,
        request.conversationId,
      );
      await repairMissingSessionCwd(persistentSessionPath, process.cwd());
      args.push("--session", persistentSessionPath);
    }
    const provider = account?.provider ?? this.#provider;
    const model = account?.model ?? this.#model;
    const thinking = request.thinking ?? account?.thinking ?? this.#thinking;
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    // Hands-local surfaces (the api surface) turn off pi's seven built-in file
    // and shell tools. Sandi-owned proxy tools, loaded as an extension, take
    // their place and run on the caller's desktop instead of the server.
    if (request.surfaceContext?.disableBuiltinTools) {
      args.push("--no-builtin-tools");
    }

    const auditFields = providerAccountAuditFields({
      request,
      account,
      provider,
      model,
      thinking,
    });
    log.info("provider account route selected", auditFields);

    const turnId = randomUUID();
    const deliverySideEffectFile = join(
      this.#sessionDir,
      "turn-side-effects",
      `${safeSessionName(request.conversationId)}-${turnId}.jsonl`,
    );
    const stopFile = stopFilePath(this.#sessionDir, request.conversationId);
    await mkdir(dirname(deliverySideEffectFile), { recursive: true });
    await mkdir(dirname(stopFile), { recursive: true });
    await rm(stopFile, { force: true });

    try {
      const result = await this.#run(
        args,
        request.timeoutMs ?? this.#timeoutMs,
        request.platformContext,
        request.surfaceContext,
        request.memoryContext,
        this.#eventsRoot,
        this.#remindersRoot,
        this.#feedbackRoot,
        this.#skillsRoot,
        deliverySideEffectFile,
        stopFile,
        {
          conversationId: request.conversationId,
          sessionMode: request.sessionMode ?? "persistent",
          tokenUsagePath: this.#tokenUsagePath,
          provider,
          model,
          accountId: account?.id,
        },
        account,
        this.#agentDir,
        this.#packageDir,
        request.localToolBroker,
        request.input,
        request.signal,
      );
      if (!result.ok) {
        const deliverySideEffects = await deliverySideEffectFileHasEntries(
          deliverySideEffectFile,
        );
        log.warn("provider account route failed", {
          ...auditFields,
          reason: classifyProviderFailure(result),
          exitCode: result.exitCode,
          deliverySideEffects,
        });
        const errorInput = {
          message: providerErrorMessage(result),
          reason: classifyProviderFailure(result),
          exitCode: result.exitCode,
          stderr: result.stderr,
          deliverySideEffects,
        };
        throw new ProviderTurnError(
          account?.id ? { ...errorInput, accountId: account.id } : errorInput,
        );
      }

      const deliverySideEffects = await deliverySideEffectFileHasEntries(
        deliverySideEffectFile,
      );
      log.info("provider account route completed", {
        ...auditFields,
        exitCode: result.exitCode,
        deliverySideEffects,
      });

      return {
        text: result.stdout.trim(),
        deliverySideEffects,
        raw: {
          exitCode: result.exitCode,
          stderr: result.stderr,
          accountId: account?.id,
        },
      };
    } finally {
      await rm(deliverySideEffectFile, { force: true });
      await rm(stopFile, { force: true });
    }
  }

  async #run(
    args: string[],
    timeoutMs: number,
    platformContext?: ProviderTurnRequest["platformContext"],
    surfaceContext?: SandiSurfaceContext,
    memoryContext?: MemoryContext,
    eventsRoot?: string,
    remindersRoot?: string,
    feedbackRoot?: string,
    skillsRoot?: string,
    deliverySideEffectFile?: string,
    stopFile?: string,
    usageMetadata?: TokenUsageMetadata,
    account?: PiExecutionAccount,
    agentDir?: string,
    packageDir?: string,
    localToolBroker?: LocalToolBroker,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "aborted",
          timedOut: false,
          aborted: true,
        });
        return;
      }

      const child = spawnCommandWithPipeStdin(this.#command, args, {
        cwd: process.cwd(),
        env: childEnv(
          platformContext,
          surfaceContext,
          memoryContext,
          eventsRoot,
          remindersRoot,
          feedbackRoot,
          skillsRoot,
          deliverySideEffectFile,
          stopFile,
          usageMetadata,
          account,
          agentDir,
          packageDir,
          localToolBroker,
        ),
      });
      child.stdin.on("error", () => {
        // Close reports the real failure if the child exits before reading stdin.
      });
      child.stdin.end(stdin ?? "", "utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];
      let timedOut = false;
      let aborted = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
      const abortChild = (): void => {
        aborted = true;
        if (stopFile) {
          void writeFile(stopFile, `${new Date().toISOString()}\n`, "utf8");
        }
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGTERM");
        }, 30_000);
      };
      signal?.addEventListener("abort", abortChild, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        signal?.removeEventListener("abort", abortChild);
        resolve({
          ok: false,
          exitCode: null,
          stdout: stdout.join(""),
          stderr: aborted ? "aborted" : error.message,
          timedOut,
          aborted,
        });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        signal?.removeEventListener("abort", abortChild);
        resolve({
          ok: exitCode === 0 && !aborted,
          exitCode,
          stdout: stdout.join(""),
          stderr: aborted ? "aborted" : stderr.join(""),
          timedOut,
          aborted,
        });
      });
    });
  }
}

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

function providerErrorMessage(result: CommandResult): string {
  if (result.aborted) return "pi turn was stopped";
  if (result.timedOut) return "pi timed out before Sandi could respond";
  return (
    firstMeaningfulLine(result.stderr) ??
    firstMeaningfulLine(result.stdout) ??
    `pi exited with code ${result.exitCode}`
  );
}

function classifyProviderFailure(result: CommandResult): ProviderFailureReason {
  if (result.aborted) return "aborted";
  if (result.timedOut) return "timeout";
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("429")
  ) {
    return "rate-limit";
  }
  if (
    text.includes("usage cap") ||
    text.includes("message cap") ||
    text.includes("quota") ||
    text.includes("plan limit") ||
    (text.includes("limit") &&
      (text.includes("chatgpt") ||
        text.includes("usage") ||
        text.includes("messages")))
  ) {
    return "quota-limit";
  }
  return "unknown";
}

function providerAccountAuditFields(input: {
  request: ProviderTurnRequest;
  account: PiExecutionAccount | undefined;
  provider: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
}): Record<string, unknown> {
  return {
    audit: "per-human-chatgpt-account-routing",
    conversationId: input.request.conversationId,
    sessionMode: input.request.sessionMode ?? "persistent",
    routingIdentityId: input.request.accountRouting?.identityId ?? null,
    piAccountId: input.account?.id ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
  };
}

function firstMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function safeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sessionPath(sessionDir: string, conversationId: string): string {
  return join(sessionDir, `${safeSessionName(conversationId)}.jsonl`);
}

function stopFilePath(sessionDir: string, conversationId: string): string {
  return join(
    sessionDir,
    "turn-stops",
    `${safeSessionName(conversationId)}.stop`,
  );
}

async function writeSystemPromptPayload(
  sessionDir: string,
  instructions: string,
): Promise<string> {
  const hash = createHash("sha256").update(instructions).digest("hex");
  const path = join(sessionDir, "payloads", "system-prompt", `${hash}.txt`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, instructions, "utf8");
  return path;
}

async function repairMissingSessionCwd(
  persistentSessionPath: string,
  currentCwd: string,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(persistentSessionPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  const newlineIndex = text.indexOf("\n");
  const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : text.slice(newlineIndex);
  let firstEntry: unknown;
  try {
    firstEntry = JSON.parse(firstLine);
  } catch {
    return;
  }
  if (!isObjectRecord(firstEntry)) return;
  if (firstEntry["type"] !== "session") return;
  const storedCwd = firstEntry["cwd"];
  if (typeof storedCwd !== "string" || storedCwd === currentCwd) return;
  if (await pathExists(storedCwd)) return;
  if (!(await pathExists(currentCwd))) return;

  firstEntry["cwd"] = currentCwd;
  const tempPath = `${persistentSessionPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(firstEntry)}${rest}`, "utf8");
  await rename(tempPath, persistentSessionPath);
  log.warn("repaired missing persistent Pi session cwd", {
    sessionPath: persistentSessionPath,
    previousCwd: storedCwd,
    currentCwd,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    if (isNodeError(error) && error.code === "ENOTDIR") return false;
    throw error;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function childEnv(
  platformContext: ProviderTurnRequest["platformContext"],
  surfaceContext: SandiSurfaceContext | undefined,
  memoryContext: MemoryContext | undefined,
  eventsRoot: string | undefined,
  remindersRoot: string | undefined,
  feedbackRoot: string | undefined,
  skillsRoot: string | undefined,
  deliverySideEffectFile: string | undefined,
  stopFile: string | undefined,
  usageMetadata: TokenUsageMetadata | undefined,
  account: PiExecutionAccount | undefined,
  agentDir: string | undefined,
  packageDir: string | undefined,
  localToolBroker: LocalToolBroker | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };
  delete env["SANDI_PLATFORM_CONTEXT"];
  delete env["SANDI_DISCORD_CONTEXT"];
  delete env["SANDI_SKILLS_SURFACE"];
  delete env["SANDI_RUNTIME_IMPORT"];
  delete env["SANDI_RUNTIME_ENTRY"];
  delete env["SANDI_SURFACE_ATTACHMENTS_ROOT"];
  delete env["SANDI_TOKEN_USAGE_PATH"];
  delete env["SANDI_CONVERSATION_ID"];
  delete env["SANDI_SESSION_MODE"];
  delete env["SANDI_PI_ACCOUNT_ID"];
  delete env["SANDI_POLICY_ROOT"];
  delete env["SANDI_POLICY_ROOTS"];
  delete env["SANDI_FEEDBACK_ROOT"];
  // Names are duplicated as string literals on the extension side on purpose:
  // the pi child loads extensions without the tsconfig path alias, so it cannot
  // import the shared constant. This and the proxy extension are the two ends of
  // that env-var contract. Always deleted first so a stale broker from the parent
  // environment can never leak into a turn that did not lease one.
  delete env["SANDI_TOOL_BROKER_URL"];
  delete env["SANDI_TOOL_BROKER_TOKEN"];
  delete env["PI_CODING_AGENT_DIR"];
  delete env["PI_PACKAGE_DIR"];
  const piAgentDir = account?.agentDir ?? agentDir;
  if (piAgentDir) {
    env["PI_CODING_AGENT_DIR"] = piAgentDir;
  }
  if (packageDir) {
    env["PI_PACKAGE_DIR"] = packageDir;
  }
  if (platformContext) {
    env["SANDI_PLATFORM_CONTEXT"] = JSON.stringify(platformContext);
  }
  if (surfaceContext) {
    env["SANDI_SKILLS_SURFACE"] = surfaceContext.skillsSurface;
    env["SANDI_RUNTIME_IMPORT"] = surfaceContext.runtimeImport;
    env["SANDI_RUNTIME_ENTRY"] = surfaceContext.runtimeEntry;
    if (surfaceContext.attachmentsRoot) {
      env["SANDI_SURFACE_ATTACHMENTS_ROOT"] = surfaceContext.attachmentsRoot;
    }
  }
  if (localToolBroker) {
    env["SANDI_TOOL_BROKER_URL"] = localToolBroker.url;
    env["SANDI_TOOL_BROKER_TOKEN"] = localToolBroker.token;
  }
  if (memoryContext) {
    env["SANDI_MEMORY_ROOT"] = memoryContext.memoryRoot;
    env["SANDI_MEMORY_CONTEXT"] = JSON.stringify({
      memoryScopes: memoryContext.memoryScopes,
      participants: memoryContext.participants.map((participant) => ({
        platform: participant.platform,
        platformUserId: participant.platformUserId,
        ref: participantMemoryRef(participant),
        username: participant.username,
        identityId: participant.identityId,
      })),
    });
  }
  if (eventsRoot) {
    env["SANDI_EVENTS_ROOT"] = eventsRoot;
  }
  if (remindersRoot) {
    env["SANDI_REMINDERS_ROOT"] = remindersRoot;
  }
  if (feedbackRoot) {
    env["SANDI_FEEDBACK_ROOT"] = feedbackRoot;
  }
  if (skillsRoot) {
    env["SANDI_SKILLS_ROOT"] = skillsRoot;
  }
  if (deliverySideEffectFile) {
    env[DELIVERY_SIDE_EFFECT_FILE_ENV] = deliverySideEffectFile;
  }
  if (stopFile) {
    env["SANDI_PI_STOP_FILE"] = stopFile;
  }
  if (usageMetadata) {
    env["SANDI_TOKEN_USAGE_PATH"] = usageMetadata.tokenUsagePath;
    env["SANDI_CONVERSATION_ID"] = usageMetadata.conversationId;
    env["SANDI_SESSION_MODE"] = usageMetadata.sessionMode;
    if (usageMetadata.accountId) {
      env["SANDI_PI_ACCOUNT_ID"] = usageMetadata.accountId;
    }
    if (usageMetadata.provider) {
      env["SANDI_PI_PROVIDER"] = usageMetadata.provider;
    }
    if (usageMetadata.model) {
      env["SANDI_PI_MODEL"] = usageMetadata.model;
    }
  }
  return env;
}

export function defaultPiJsRunExtensionPath(): string {
  return resolve("src/lib/pi-extension/js-run-tool.ts");
}

export function defaultPiImagegenExtensionPath(): string {
  return resolve("src/lib/pi-extension/imagegen-tools.ts");
}

export function defaultPiStopExtensionPath(): string {
  return resolve("src/lib/pi-extension/stop-sentinel.ts");
}

export function defaultPiTokenUsageExtensionPath(): string {
  return resolve("src/lib/pi-extension/token-usage-recorder.ts");
}

export function defaultPiMemoryExtensionPath(): string {
  return resolve("src/lib/pi-extension/memory-tools.ts");
}

export function defaultPiSkillExtensionPath(): string {
  return resolve("src/lib/pi-extension/skill-tools.ts");
}

export function defaultPiFeedbackExtensionPath(): string {
  return resolve("src/lib/pi-extension/feedback-tools.ts");
}

export function defaultPiPolicyExtensionPath(): string {
  return resolve("src/lib/pi-extension/policy-tools.ts");
}

type TokenUsageMetadata = {
  conversationId: string;
  sessionMode: "persistent" | "none";
  tokenUsagePath: string;
  provider: string | undefined;
  model: string | undefined;
  accountId: string | undefined;
};
