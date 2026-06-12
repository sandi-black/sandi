import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod/v4";
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
  try {
    const auth = await readOpenAICodexAuth(account.agentDir);
    const response = await fetch(OPENAI_USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.credentials.access}`,
        "chatgpt-account-id": auth.accountId,
        originator: "pi",
        "user-agent": "Sandi status",
      },
    });
    if (!response.ok) {
      return unavailable(
        label,
        `OpenAI usage endpoint returned ${response.status}`,
      );
    }

    const parsed = UsageResponseSchema.safeParse(await response.json());
    if (!parsed.success)
      return unavailable(label, "OpenAI usage response shape changed");

    const rateLimit = parsed.data.rate_limit;
    if (!rateLimit)
      return unavailable(label, "OpenAI usage limits are not present");

    const lines = [
      `- ${label}: ${formatPlan(parsed.data.plan_type)}${formatAllowed(rateLimit.allowed, rateLimit.limit_reached)}; ${formatWindows(rateLimit.primary_window, rateLimit.secondary_window)}`,
    ];
    return { available: true, lines };
  } catch (error) {
    return unavailable(
      label,
      error instanceof Error ? error.message : String(error),
    );
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

function formatWindows(
  primary: RateLimitWindow | undefined,
  secondary: RateLimitWindow | undefined,
): string {
  const windows = [primary, secondary]
    .filter((window): window is RateLimitWindow => window !== undefined)
    .map(
      (window) => `${formatWindowName(window)} ${formatWindowUsage(window)}`,
    );
  return windows.length > 0 ? windows.join(", ") : "no window usage";
}

function formatWindowName(window: RateLimitWindow): string {
  if (window.limit_window_seconds === 18_000) return "5h";
  if (window.limit_window_seconds === 604_800) return "week";
  return formatDuration(window.limit_window_seconds);
}

function formatWindowUsage(window: RateLimitWindow): string {
  const used = clampPercent(window.used_percent);
  const remaining = clampPercent(100 - used);
  const reset = resetDescription(window);
  return `${remaining}% remaining (${used}% used${reset})`;
}

function resetDescription(window: RateLimitWindow): string {
  if (window.reset_after_seconds !== undefined) {
    return `, resets in ${formatDuration(window.reset_after_seconds)}`;
  }
  if (window.reset_at !== undefined) {
    return `, resets at ${new Date(window.reset_at * 1000).toISOString()}`;
  }
  return "";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
