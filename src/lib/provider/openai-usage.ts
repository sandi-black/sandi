import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod/v4";
import { formatDuration } from "@/lib/duration";
import { errorMessage } from "@/lib/errors";
import type { PiAccountConfig } from "@/lib/provider/pi-account-routing";
import { writePrivateTextFile } from "@/lib/state/private-files";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

const AuthProviderSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  accountId: z.string().optional(),
});

const AuthFileSchema = z.record(z.string(), z.unknown());

const RateLimitWindowSchema = z.object({
  used_percent: z.number(),
  limit_window_seconds: z.number(),
  reset_after_seconds: z.number().optional(),
  reset_at: z.number().optional(),
});

const RateLimitSchema = z.object({
  allowed: z.boolean().optional(),
  limit_reached: z.boolean().optional(),
  primary_window: RateLimitWindowSchema.optional(),
  secondary_window: RateLimitWindowSchema.optional(),
});

const UsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: RateLimitSchema.nullable().optional(),
});

type AuthProvider = z.infer<typeof AuthProviderSchema>;
type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export type OpenAIUsageWindow = {
  kind: "five-hour" | "weekly" | "other";
  windowSeconds: number;
  usedPercent: number;
  remainingPercent: number;
  resetAfterSeconds?: number;
  resetAt?: number;
};

export type OpenAIUsageSnapshot =
  | {
      available: true;
      planType?: string;
      allowed?: boolean;
      limitReached?: boolean;
      windows: OpenAIUsageWindow[];
    }
  | { available: false; reason: string };

export type OpenAIUsageLimits = {
  available: boolean;
  lines: string[];
};

export type OpenAIUsageAccount = Pick<
  PiAccountConfig,
  "id" | "displayName" | "agentDir"
>;

export async function readOpenAIUsageLimits(
  accounts: readonly OpenAIUsageAccount[] = [defaultUsageAccount()],
): Promise<OpenAIUsageLimits> {
  const results = await Promise.all(
    accounts.map(readOpenAIUsageLimitsForAccount),
  );
  return {
    available: results.some((result) => result.available),
    lines: ["OpenAI limits:", ...results.flatMap((result) => result.lines)],
  };
}

async function readOpenAIUsageLimitsForAccount(
  account: OpenAIUsageAccount,
): Promise<OpenAIUsageLimits> {
  const label = accountLabel(account);
  const usage = await readOpenAIUsageForAccount(account);
  if (!usage.available) return unavailable(label, usage.reason);

  const lines = [
    `- ${label}: ${formatPlan(usage.planType)}${formatAllowed(usage.allowed, usage.limitReached)}; ${formatWindows(usage.windows)}`,
  ];
  return { available: true, lines };
}

export async function readOpenAIUsageForAccount(
  account: OpenAIUsageAccount,
): Promise<OpenAIUsageSnapshot> {
  try {
    const auth = await readOpenAICodexAuth(account.agentDir);
    const response = await fetch(OPENAI_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.credentials.access}`,
        "chatgpt-account-id": auth.accountId,
        originator: "pi",
        "user-agent": "Sandi usage warning",
      },
    });
    if (!response.ok) {
      return {
        available: false,
        reason: `OpenAI usage endpoint returned ${response.status}`,
      };
    }

    const parsed = UsageResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        available: false,
        reason: "OpenAI usage response shape changed",
      };
    }

    const rateLimit = parsed.data.rate_limit;
    if (!rateLimit) {
      return {
        available: false,
        reason: "OpenAI usage limits are not present",
      };
    }

    const windows = [rateLimit.primary_window, rateLimit.secondary_window]
      .filter((window): window is RateLimitWindow => window !== undefined)
      .map(toUsageWindow);
    return {
      available: true,
      ...(parsed.data.plan_type ? { planType: parsed.data.plan_type } : {}),
      ...(rateLimit.allowed !== undefined
        ? { allowed: rateLimit.allowed }
        : {}),
      ...(rateLimit.limit_reached !== undefined
        ? { limitReached: rateLimit.limit_reached }
        : {}),
      windows,
    };
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
}

async function readOpenAICodexAuth(agentDir?: string): Promise<{
  credentials: AuthProvider;
  accountId: string;
}> {
  const authPath = authFilePath(agentDir);
  const raw = AuthFileSchema.parse(
    JSON.parse(await readFile(authPath, "utf8")),
  );
  const parsed = AuthProviderSchema.safeParse(raw[OPENAI_CODEX_PROVIDER_ID]);
  if (!parsed.success) throw new Error("OpenAI Codex auth is not configured");

  let credentials = parsed.data;
  if (credentials.expires <= Date.now() + TOKEN_REFRESH_LEEWAY_MS) {
    credentials = await refreshOpenAICodexAuth(credentials.refresh);
    await writePrivateTextFile(
      authPath,
      `${JSON.stringify({ ...raw, [OPENAI_CODEX_PROVIDER_ID]: credentials }, null, 2)}\n`,
    );
  }

  const accountId =
    credentials.accountId ?? accountIdFromToken(credentials.access);
  return { credentials, accountId };
}

async function refreshOpenAICodexAuth(
  refreshToken: string,
): Promise<AuthProvider> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error("OpenAI Codex token refresh failed");

  const body = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      expires_in: z.number(),
    })
    .parse(await response.json());

  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    accountId: accountIdFromToken(body.access_token),
  };
}

function authFilePath(agentDir?: string): string {
  const root =
    agentDir ??
    process.env["PI_CODING_AGENT_DIR"]?.trim() ??
    join(homedir(), ".pi", "agent");
  return join(root, "auth.json");
}

function accountIdFromToken(token: string): string {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload)
    throw new Error("OpenAI Codex token is invalid");
  const decoded = JSON.parse(
    Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8"),
  );
  const parsed = z
    .object({
      [JWT_CLAIM_PATH]: z.object({
        chatgpt_account_id: z.string().min(1),
      }),
    })
    .parse(decoded);
  return parsed[JWT_CLAIM_PATH].chatgpt_account_id;
}

function base64UrlToBase64(value: string): string {
  return value.replaceAll("-", "+").replaceAll("_", "/");
}

function unavailable(label: string, reason: string): OpenAIUsageLimits {
  return {
    available: false,
    lines: [`- ${label}: unavailable (${reason})`],
  };
}

function defaultUsageAccount(): OpenAIUsageAccount {
  return { id: "default", displayName: "Default" };
}

function accountLabel(account: OpenAIUsageAccount): string {
  return account.displayName ?? account.id;
}

function formatPlan(planType: string | undefined): string {
  return planType ? `${planType} plan` : "plan unknown";
}

function formatAllowed(
  allowed: boolean | undefined,
  limitReached: boolean | undefined,
): string {
  if (limitReached) return ", limit reached";
  if (allowed === false) return ", blocked";
  if (allowed === true) return ", allowed";
  return "";
}

function formatWindows(windows: readonly OpenAIUsageWindow[]): string {
  const formatted = windows.map(
    (window) => `${formatWindowName(window)} ${formatWindowUsage(window)}`,
  );
  return formatted.length > 0 ? formatted.join(", ") : "no window usage";
}

function formatWindowName(window: OpenAIUsageWindow): string {
  if (window.kind === "five-hour") return "5h";
  if (window.kind === "weekly") return "week";
  return formatDuration(window.windowSeconds * 1_000, {
    granularity: "minutes",
  });
}

function formatWindowUsage(window: OpenAIUsageWindow): string {
  const used = clampPercent(window.usedPercent);
  const remaining = clampPercent(window.remainingPercent);
  const reset = resetDescription(window);
  return `${remaining}% remaining (${used}% used${reset})`;
}

function resetDescription(window: OpenAIUsageWindow): string {
  if (window.resetAfterSeconds !== undefined) {
    return `, resets in ${formatDuration(window.resetAfterSeconds * 1_000, { granularity: "minutes" })}`;
  }
  if (window.resetAt !== undefined) {
    return `, resets at ${new Date(window.resetAt * 1000).toISOString()}`;
  }
  return "";
}

function toUsageWindow(window: RateLimitWindow): OpenAIUsageWindow {
  const kind = windowKind(window.limit_window_seconds);
  return {
    kind,
    windowSeconds: window.limit_window_seconds,
    usedPercent: window.used_percent,
    remainingPercent: clampRawPercent(100 - window.used_percent),
    ...(window.reset_after_seconds !== undefined
      ? { resetAfterSeconds: window.reset_after_seconds }
      : {}),
    ...(window.reset_at !== undefined ? { resetAt: window.reset_at } : {}),
  };
}

function windowKind(windowSeconds: number): OpenAIUsageWindow["kind"] {
  if (windowSeconds === 18_000) return "five-hour";
  if (windowSeconds === 604_800) return "weekly";
  return "other";
}

function clampRawPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
