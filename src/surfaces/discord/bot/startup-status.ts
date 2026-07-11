import { spawn } from "node:child_process";

import {
  type Channel,
  ChannelType,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";

import { formatDuration } from "@/lib/duration";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  type OpenAIUsageAccount,
  readOpenAIUsageLimits,
} from "@/lib/provider/openai-usage";
import type { PiAccountConfig } from "@/lib/provider/pi-account-routing";
import {
  formatAccountTokenUsageRollups,
  readAccountTokenUsageRollups,
} from "@/lib/provider/token-usage";
import type { DiscordConfig } from "@/surfaces/discord/config";

const log = createLogger("startup-status");
const GIT_PROBE_TIMEOUT_MS = 3_000;
const GIT_PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
const GIT_STATUS_PROBE_BYTES = 256;

export async function postStartupStatus(
  client: Client,
  config: DiscordConfig,
): Promise<void> {
  try {
    const channel = await findStatusChannel(client, config);
    if (!channel) {
      log.info("startup status channel not found", {
        channelId: config.statusChannelId ?? "none",
        channelName: config.statusChannelName,
      });
      return;
    }

    await channel.send(await startupStatusMessage());
  } catch (error) {
    log.error("failed to post startup status", {
      error: errorMessage(error),
    });
  }
}

async function findStatusChannel(
  client: Client,
  config: DiscordConfig,
): Promise<TextChannel | undefined> {
  if (config.statusChannelId) {
    const channel = await client.channels.fetch(config.statusChannelId);
    return asStatusChannel(channel);
  }

  const guild = await client.guilds.fetch(config.guildId);
  return findStatusChannelByName(guild, config.statusChannelName);
}

async function findStatusChannelByName(
  guild: Guild,
  channelName: string,
): Promise<TextChannel | undefined> {
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    const statusChannel = asStatusChannel(channel);
    if (statusChannel?.name === channelName) return statusChannel;
  }
  return undefined;
}

function asStatusChannel(channel: Channel | null): TextChannel | undefined {
  if (!channel) return undefined;
  if (channel.type !== ChannelType.GuildText) return undefined;
  return channel;
}

async function startupStatusMessage(): Promise<string> {
  const gitStatus = await readGitStatus();
  return `🧹 Sandi restarted: ${formatGitStatus(gitStatus)}`;
}

export async function botStatusMessage(input: {
  queueRunning: boolean;
  queuedJobs: number;
  model: string | undefined;
  provider: string | undefined;
  thinking: string | undefined;
  tokenUsagePath: string;
  accounts: readonly PiAccountConfig[];
  contextTokens?: number;
}): Promise<string> {
  const gitStatus = await readGitStatus();
  const accounts = statusAccounts(input.accounts);
  const usage = await readOpenAIUsageLimits(accounts);
  const lines = [`🧹 Sandi status: ${formatGitStatus(gitStatus)}`];
  lines.push(`Queue: ${formatQueueStatus(input)}`);
  lines.push(`Runtime: ${formatRuntimeStatus()}`);
  lines.push(`Pi: ${formatPiStatus(input)}`);
  lines.push(
    ...formatAccountTokenUsageRollups(
      await readAccountTokenUsageRollups({
        path: input.tokenUsagePath,
        accounts,
      }),
    ),
  );
  if (input.contextTokens !== undefined) {
    lines.push(
      `Context: ~${formatTokens(input.contextTokens)} tokens compiled`,
    );
  }
  lines.push(...usage.lines);
  return lines.join("\n");
}

type GitStatus = {
  branch: string;
  shortSha: string;
  cleanState: "clean" | "dirty" | "unknown";
};

function formatGitStatus(status: GitStatus): string {
  return `${status.branch}@${status.shortSha}, ${status.cleanState}`;
}

function formatQueueStatus(input: {
  queueRunning: boolean;
  queuedJobs: number;
}): string {
  if (!input.queueRunning) return "idle";
  if (input.queuedJobs === 0) return "active";
  const suffix = input.queuedJobs === 1 ? "turn" : "turns";
  return `active, ${input.queuedJobs} queued ${suffix}`;
}

function formatRuntimeStatus(): string {
  const memory = process.memoryUsage();
  return [
    `up ${formatDuration(process.uptime() * 1_000, { granularity: "seconds" })}`,
    `rss ${formatBytes(memory.rss)}`,
    `heap ${formatBytes(memory.heapUsed)}/${formatBytes(memory.heapTotal)}`,
  ].join(", ");
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function formatPiStatus(input: {
  model: string | undefined;
  provider: string | undefined;
  thinking: string | undefined;
}): string {
  const model = input.model ?? "default model";
  const provider = input.provider ?? "default provider";
  const thinking = input.thinking ? `, thinking ${input.thinking}` : "";
  return `${provider}/${model}${thinking}`;
}

function statusAccounts(
  accounts: readonly PiAccountConfig[],
): readonly OpenAIUsageAccount[] {
  if (accounts.length > 0) return accounts;
  return [{ id: "default", displayName: "Default" }];
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${formatShortNumber(value / 1_000)}k`;
  return `${formatShortNumber(value / 1_000_000)}M`;
}

function formatShortNumber(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

async function readGitStatus(): Promise<GitStatus> {
  const [shortShaResult, branchResult, fallbackBranchResult, statusResult] =
    await Promise.all([
      git(["rev-parse", "--short", "HEAD"]),
      git(["branch", "--show-current"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["status", "--porcelain"], GIT_STATUS_PROBE_BYTES),
    ]);
  const shortSha = successfulOutput(shortShaResult) || "unknown";
  const branch =
    successfulOutput(branchResult) ||
    successfulOutput(fallbackBranchResult) ||
    "unknown";
  const cleanState = statusResult.output
    ? "dirty"
    : statusResult.succeeded
      ? "clean"
      : "unknown";

  return {
    branch,
    shortSha,
    cleanState,
  };
}

function successfulOutput(result: BoundedCommandResult): string {
  return result.succeeded ? result.output : "";
}

function git(
  args: readonly string[],
  maxOutputBytes = GIT_PROBE_MAX_OUTPUT_BYTES,
): Promise<BoundedCommandResult> {
  return runBoundedCommand("git", args, {
    cwd: process.cwd(),
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    maxOutputBytes,
  });
}

export type BoundedCommandResult = {
  output: string;
  succeeded: boolean;
};

export function runBoundedCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<BoundedCommandResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Command timeout must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0
  ) {
    throw new Error("Command output limit must be a positive integer.");
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        output: Buffer.concat(chunks, outputBytes).toString("utf8").trim(),
        succeeded,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        outputBytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) {
        finish(false);
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      finish(false);
    });
    child.on("close", (code) => {
      finish(code === 0);
    });
    timeout = setTimeout(() => {
      finish(false);
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timeout.unref();
  });
}
