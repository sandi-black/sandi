import { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import {
  type CodexAuthFetch,
  credentialFromTokenResponse,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_URL,
  type OpenAICodexOAuthCredential,
} from "@/lib/provider/openai-codex-auth";

export const OPENAI_CODEX_DEVICE_USER_CODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_CODEX_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_CODEX_DEVICE_VERIFICATION_URI =
  "https://auth.openai.com/codex/device";
export const OPENAI_CODEX_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";
export const OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS = 15 * 60;

const MINIMUM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5_000;

const UserCodeResponseSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.union([z.number(), z.string()]),
});

const DeviceAuthSuccessSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

const DeviceAuthErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string().optional(),
    }),
  ]),
});

export type CodexDeviceLoginClock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type CodexDeviceLoginPending = {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  complete: (signal?: AbortSignal) => Promise<CodexDeviceLoginCompletion>;
};

export type CodexDeviceLoginCompletion =
  | { kind: "authorized"; credential: OpenAICodexOAuthCredential }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

type DeviceAuthStart = {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
};

type DeviceAuthAuthorization = {
  authorizationCode: string;
  codeVerifier: string;
};

type DevicePollStatus =
  | { status: "complete"; value: DeviceAuthAuthorization }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "failed"; message: string };

export async function startOpenAICodexDeviceLogin(input?: {
  fetch?: CodexAuthFetch;
  clock?: CodexDeviceLoginClock;
}): Promise<CodexDeviceLoginPending> {
  const fetchImpl = input?.fetch ?? fetch;
  const clock = input?.clock ?? systemClock();
  const device = await requestDeviceUserCode(fetchImpl);
  return {
    userCode: device.userCode,
    verificationUri: OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    expiresInSeconds: OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS,
    complete: (signal) =>
      completeOpenAICodexDeviceLogin({
        device,
        fetch: fetchImpl,
        clock,
        ...(signal ? { signal } : {}),
      }),
  };
}

async function completeOpenAICodexDeviceLogin(input: {
  device: DeviceAuthStart;
  fetch: CodexAuthFetch;
  clock: CodexDeviceLoginClock;
  signal?: AbortSignal;
}): Promise<CodexDeviceLoginCompletion> {
  try {
    const authorization = await pollDeviceAuthorization(input);
    const response = await fetchWithLoginCancellation(
      input.fetch,
      OPENAI_CODEX_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OPENAI_CODEX_CLIENT_ID,
          code: authorization.authorizationCode,
          code_verifier: authorization.codeVerifier,
          redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        kind: "failed",
        message: `OpenAI Codex token exchange failed (${response.status})${body ? `: ${body}` : ""}`,
      };
    }
    return {
      kind: "authorized",
      credential: credentialFromTokenResponse(
        await response.json(),
        input.clock.now(),
      ),
    };
  } catch (error) {
    if (isAbortError(error)) return { kind: "cancelled" };
    if (isTimeoutError(error)) return { kind: "timeout" };
    return { kind: "failed", message: errorMessage(error) };
  }
}

async function requestDeviceUserCode(
  fetchImpl: CodexAuthFetch,
): Promise<DeviceAuthStart> {
  const response = await fetchImpl(OPENAI_CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "OpenAI Codex device code login is not enabled. Use browser login or verify the auth server URL.",
      );
    }
    const body = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex device code request failed with status ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
  const parsed = UserCodeResponseSchema.parse(await response.json());
  const intervalSeconds =
    typeof parsed.interval === "string"
      ? Number(parsed.interval.trim())
      : parsed.interval;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error(
      `Invalid OpenAI Codex device code interval: ${JSON.stringify(parsed.interval)}`,
    );
  }
  return {
    deviceAuthId: parsed.device_auth_id,
    userCode: parsed.user_code,
    intervalSeconds,
  };
}

async function pollDeviceAuthorization(input: {
  device: DeviceAuthStart;
  fetch: CodexAuthFetch;
  clock: CodexDeviceLoginClock;
  signal?: AbortSignal;
}): Promise<DeviceAuthAuthorization> {
  const deadline =
    input.clock.now() + OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS * 1000;
  let intervalMs = Math.max(
    MINIMUM_POLL_INTERVAL_MS,
    Math.floor(
      (input.device.intervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    ),
  );

  while (input.clock.now() < deadline) {
    if (input.signal?.aborted) throw abortError();
    const result = await pollDeviceToken(input);
    switch (result.status) {
      case "complete":
        return result.value;
      case "failed":
        throw new Error(result.message);
      case "pending":
        break;
      case "slow_down":
        intervalMs = Math.max(
          MINIMUM_POLL_INTERVAL_MS,
          intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS,
        );
        break;
      default: {
        const _exhaustive: never = result;
        throw new Error(`Unhandled device poll status: ${_exhaustive}`);
      }
    }
    const remainingMs = deadline - input.clock.now();
    if (remainingMs <= 0) break;
    await input.clock.sleep(Math.min(intervalMs, remainingMs), input.signal);
  }

  throw timeoutError();
}

async function pollDeviceToken(input: {
  device: DeviceAuthStart;
  fetch: CodexAuthFetch;
  signal?: AbortSignal;
}): Promise<DevicePollStatus> {
  const response = await fetchWithLoginCancellation(
    input.fetch,
    OPENAI_CODEX_DEVICE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: input.device.deviceAuthId,
        user_code: input.device.userCode,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (response.ok) {
    const parsed = DeviceAuthSuccessSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: "failed",
        message: `Invalid OpenAI Codex device auth token response: ${parsed.error.message}`,
      };
    }
    return {
      status: "complete",
      value: {
        authorizationCode: parsed.data.authorization_code,
        codeVerifier: parsed.data.code_verifier,
      },
    };
  }
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  const body = await response.text().catch(() => "");
  const errorCode = deviceAuthErrorCode(body);
  if (errorCode === "deviceauth_authorization_pending") {
    return { status: "pending" };
  }
  if (errorCode === "slow_down") return { status: "slow_down" };
  return {
    status: "failed",
    message: `OpenAI Codex device auth failed with status ${response.status}${body ? `: ${body}` : ""}`,
  };
}

async function fetchWithLoginCancellation(
  fetchImpl: CodexAuthFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) throw abortError();
    throw error;
  }
}

function deviceAuthErrorCode(body: string): string | undefined {
  if (body.trim().length === 0) return undefined;
  try {
    const parsed = DeviceAuthErrorSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return undefined;
    if (typeof parsed.data.error === "string") return parsed.data.error;
    return parsed.data.error.code;
  } catch {
    return undefined;
  }
}

function systemClock(): CodexDeviceLoginClock {
  return {
    now: () => Date.now(),
    sleep: abortableSleep,
  };
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Login cancelled");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  const error = new Error("Device flow timed out");
  error.name = "TimeoutError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
