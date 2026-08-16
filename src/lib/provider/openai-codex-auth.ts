import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod/v4";
import { isMissingFileError } from "@/lib/fs-errors";
import { writePrivateTextFile } from "@/lib/state/private-files";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OPENAI_CODEX_TOKEN_REFRESH_LEEWAY_MS = 60_000;

const StoredCodexCredentialSchema = z.object({
  type: z.literal("oauth").optional(),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  accountId: z.string().optional(),
});

const AuthFileSchema = z.record(z.string(), z.unknown());

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
});

const CodexAccountClaimsSchema = z.object({
  [OPENAI_CODEX_JWT_CLAIM_PATH]: z.object({
    chatgpt_account_id: z.string().min(1),
  }),
});

export type OpenAICodexOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type CodexAuthFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

type OpenAICodexAuthFile = Record<string, unknown>;

export function defaultPiAgentDir(override?: string): string {
  return (
    override?.trim() ||
    process.env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(homedir(), ".pi", "agent")
  );
}

export function openaiCodexAuthFilePath(agentDir?: string): string {
  return join(defaultPiAgentDir(agentDir), "auth.json");
}

export async function loadOpenAICodexAuth(input?: {
  agentDir?: string;
  now?: number;
  fetch?: CodexAuthFetch;
}): Promise<OpenAICodexOAuthCredential> {
  const authPath = openaiCodexAuthFilePath(input?.agentDir);
  const raw = await readAuthFile(authPath);
  const parsed = StoredCodexCredentialSchema.safeParse(
    raw[OPENAI_CODEX_PROVIDER_ID],
  );
  if (!parsed.success) throw new Error("OpenAI Codex auth is not configured");

  let credential = normalizeCodexCredential(parsed.data);
  const now = input?.now ?? Date.now();
  if (credential.expires <= now + OPENAI_CODEX_TOKEN_REFRESH_LEEWAY_MS) {
    credential = await refreshOpenAICodexAuth({
      refreshToken: credential.refresh,
      ...(input?.fetch ? { fetch: input.fetch } : {}),
      now,
    });
    await persistOpenAICodexAuth({
      credential,
      existing: raw,
      ...(input?.agentDir ? { agentDir: input.agentDir } : {}),
    });
  }

  return credential;
}

export async function persistOpenAICodexAuth(input: {
  agentDir?: string;
  credential: OpenAICodexOAuthCredential;
  existing?: OpenAICodexAuthFile;
}): Promise<void> {
  const authPath = openaiCodexAuthFilePath(input.agentDir);
  const existing = input.existing ?? (await readAuthFile(authPath, true));
  await mkdir(dirname(authPath), { recursive: true });
  await writePrivateTextFile(
    authPath,
    `${JSON.stringify(
      { ...existing, [OPENAI_CODEX_PROVIDER_ID]: input.credential },
      null,
      2,
    )}\n`,
  );
}

export async function refreshOpenAICodexAuth(input: {
  refreshToken: string;
  fetch?: CodexAuthFetch;
  now?: number;
}): Promise<OpenAICodexOAuthCredential> {
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error("OpenAI Codex token refresh failed");
  return credentialFromTokenResponse(await response.json(), input.now);
}

export function credentialFromTokenResponse(
  value: unknown,
  now = Date.now(),
): OpenAICodexOAuthCredential {
  const body = TokenResponseSchema.parse(value);
  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: now + body.expires_in * 1000,
    accountId: accountIdFromOpenAICodexToken(body.access_token),
  };
}

export function accountIdFromOpenAICodexToken(token: string): string {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new Error("OpenAI Codex token is invalid");
  }
  const decoded = JSON.parse(
    Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8"),
  );
  return CodexAccountClaimsSchema.parse(decoded)[OPENAI_CODEX_JWT_CLAIM_PATH]
    .chatgpt_account_id;
}

function normalizeCodexCredential(
  stored: z.infer<typeof StoredCodexCredentialSchema>,
): OpenAICodexOAuthCredential {
  return {
    type: "oauth",
    access: stored.access,
    refresh: stored.refresh,
    expires: stored.expires,
    accountId: stored.accountId ?? accountIdFromOpenAICodexToken(stored.access),
  };
}

async function readAuthFile(
  authPath: string,
  allowMissing = false,
): Promise<OpenAICodexAuthFile> {
  try {
    return AuthFileSchema.parse(JSON.parse(await readFile(authPath, "utf8")));
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) return {};
    throw error;
  }
}

function base64UrlToBase64(value: string): string {
  return value.replaceAll("-", "+").replaceAll("_", "/");
}
