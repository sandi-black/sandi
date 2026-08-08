import { join } from "node:path";

import { z } from "zod/v4";
import type { DurableOutbox } from "@/lib/delivery/outbox";
import { formatDuration } from "@/lib/duration";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  type OpenAIUsageAccount,
  type OpenAIUsageSnapshot,
  type OpenAIUsageWindow,
  readOpenAIUsageForAccount,
} from "@/lib/provider/openai-usage";
import type { PiAccountConfig } from "@/lib/provider/pi-account-routing";
import type { ProviderTurnResponse } from "@/lib/provider/pi-cli-client";
import { JsonFileStore } from "@/lib/state/file-store";
import { enqueueDiscordMessage } from "@/surfaces/discord/bot/delivery-outbox";

const log = createLogger("usage-threshold-warning");
const WARNING_STATE_PATH = "provider-usage/threshold-warnings.json";
const FIRST_WARNING_BLOCK = 80;

const WindowStateSchema = z.object({
  remainingPercent: z.number().min(0).max(100),
  notifiedBlock: z.number().int().min(0).max(FIRST_WARNING_BLOCK).optional(),
});
const UserStateSchema = z.object({
  accountId: z.string().min(1),
  windows: z.object({
    fiveHour: WindowStateSchema.optional(),
    weekly: WindowStateSchema.optional(),
  }),
});
const WarningStateSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string().min(1), UserStateSchema),
});

type WarningState = z.infer<typeof WarningStateSchema>;
type UserState = z.infer<typeof UserStateSchema>;
type WindowState = z.infer<typeof WindowStateSchema>;
type WindowKey = keyof UserState["windows"];
type UsageReader = (
  account: OpenAIUsageAccount,
) => Promise<OpenAIUsageSnapshot>;
type WarningTarget = {
  discordUserId: string;
  accountId: string | undefined;
};

export type PreparedUsageWarning = {
  response: ProviderTurnResponse;
  standaloneContent?: string;
};

const EMPTY_STATE: WarningState = { version: 1, users: {} };

export class UsageThresholdWarning {
  readonly #accounts: readonly PiAccountConfig[];
  readonly #defaultAccount: OpenAIUsageAccount;
  readonly #readUsage: UsageReader;
  readonly #store: JsonFileStore<WarningState>;

  constructor(input: {
    dataDir: string;
    accounts: readonly PiAccountConfig[];
    defaultAgentDir?: string;
    readUsage?: UsageReader;
  }) {
    this.#accounts = input.accounts;
    this.#defaultAccount = {
      id: "default",
      displayName: "Default",
      ...(input.defaultAgentDir ? { agentDir: input.defaultAgentDir } : {}),
    };
    this.#readUsage = input.readUsage ?? readOpenAIUsageForAccount;
    this.#store = new JsonFileStore(
      join(input.dataDir, WARNING_STATE_PATH),
      WarningStateSchema,
    );
  }

  async prepare(
    input: WarningTarget & { response: ProviderTurnResponse },
  ): Promise<PreparedUsageWarning> {
    try {
      const account = this.#account(input.accountId);
      if (!account) return { response: input.response };
      const usage = await this.#readUsage(account);
      if (!usage.available) {
        log.warn("OpenAI usage is unavailable for threshold warning", {
          accountId: account.id,
          reason: usage.reason,
        });
        return { response: input.response };
      }

      const relevantWindows = usage.windows.filter(isWarningWindow);
      if (relevantWindows.length === 0) return { response: input.response };

      let shouldNotify = false;
      await this.#store.updateManaged((state) => {
        const previous = state.users[input.discordUserId];
        const advanced = advanceUserState(
          previous?.accountId === account.id ? previous : undefined,
          account.id,
          relevantWindows,
        );
        shouldNotify = advanced.shouldNotify;
        return {
          ...state,
          users: { ...state.users, [input.discordUserId]: advanced.state },
        };
      }, EMPTY_STATE);

      if (!shouldNotify) return { response: input.response };
      return attachUsageWarning(
        input.response,
        formatUsageWarning(relevantWindows),
      );
    } catch (error) {
      log.warn("failed to process usage threshold warning", {
        discordUserId: input.discordUserId,
        accountId: input.accountId ?? "unrouted",
        error: errorMessage(error),
      });
      return { response: input.response };
    }
  }

  #account(accountId: string | undefined): OpenAIUsageAccount | undefined {
    if (accountId) {
      return this.#accounts.find((account) => account.id === accountId);
    }
    if (this.#accounts.length > 0) return undefined;
    return this.#defaultAccount;
  }
}

function advanceUserState(
  previous: UserState | undefined,
  accountId: string,
  windows: readonly OpenAIUsageWindow[],
): { state: UserState; shouldNotify: boolean } {
  let nextWindows = previous?.windows ?? {};
  let shouldNotify = false;

  for (const window of windows) {
    const key = windowKey(window);
    const advanced = advanceWindow(nextWindows[key], window.remainingPercent);
    nextWindows = { ...nextWindows, [key]: advanced.state };
    shouldNotify ||= advanced.shouldNotify;
  }

  return {
    state: { accountId, windows: nextWindows },
    shouldNotify,
  };
}

function advanceWindow(
  previous: WindowState | undefined,
  remainingPercent: number,
): { state: WindowState; shouldNotify: boolean } {
  if (previous && remainingPercent > previous.remainingPercent) {
    return { state: { remainingPercent }, shouldNotify: false };
  }

  const block = warningBlock(remainingPercent);
  if (block === undefined || previous?.notifiedBlock === block) {
    return {
      state:
        previous?.notifiedBlock === undefined
          ? { remainingPercent }
          : { remainingPercent, notifiedBlock: previous.notifiedBlock },
      shouldNotify: false,
    };
  }

  return {
    state: { remainingPercent, notifiedBlock: block },
    shouldNotify: true,
  };
}

function warningBlock(remainingPercent: number): number | undefined {
  const block = Math.floor(remainingPercent / 10) * 10;
  return block <= FIRST_WARNING_BLOCK ? block : undefined;
}

function isWarningWindow(
  window: OpenAIUsageWindow,
): window is OpenAIUsageWindow & { kind: "five-hour" | "weekly" } {
  return window.kind === "five-hour" || window.kind === "weekly";
}

function windowKey(window: OpenAIUsageWindow): WindowKey {
  return window.kind === "five-hour" ? "fiveHour" : "weekly";
}

function formatUsageWarning(windows: readonly OpenAIUsageWindow[]): string {
  const byKind = new Map(windows.map((window) => [window.kind, window]));
  const parts: string[] = [];
  for (const [kind, label] of [
    ["five-hour", "5h"],
    ["weekly", "week"],
  ] as const) {
    const window = byKind.get(kind);
    if (window) parts.push(`${label} ${formatWindow(window)}`);
  }
  return `-# OpenAI usage: ${parts.join("; ")}`;
}

function formatWindow(window: OpenAIUsageWindow): string {
  const remaining = formatPercent(window.remainingPercent);
  if (window.resetAfterSeconds !== undefined) {
    const reset = formatDuration(window.resetAfterSeconds * 1_000, {
      granularity: "minutes",
    });
    return `${remaining}% remaining (resets in ${reset})`;
  }
  if (window.resetAt !== undefined) {
    return `${remaining}% remaining (resets at ${new Date(window.resetAt * 1_000).toISOString()})`;
  }
  return `${remaining}% remaining`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function attachUsageWarning(
  response: ProviderTurnResponse,
  content: string,
): PreparedUsageWarning {
  if (response.deliverySideEffects || !response.text.trim()) {
    return { response, standaloneContent: content };
  }
  return {
    response: {
      ...response,
      text: `${response.text.trim()}\n\n${content}`,
    },
  };
}

export async function enqueueStandaloneUsageWarning(input: {
  outbox: DurableOutbox;
  channelId: string;
  messageId: string;
  content: string | undefined;
}): Promise<void> {
  if (!input.content) return;
  try {
    await enqueueDiscordMessage({
      outbox: input.outbox,
      idempotencyKey: `discord:usage-warning:${input.messageId}`,
      payload: {
        channelId: input.channelId,
        chunks: [input.content],
        replyToMessageId: input.messageId,
      },
    });
  } catch (error) {
    log.warn("failed to deliver standalone usage threshold warning", {
      messageId: input.messageId,
      channelId: input.channelId,
      error: errorMessage(error),
    });
  }
}
