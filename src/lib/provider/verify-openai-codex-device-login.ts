import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type CodexAuthFetch,
  OPENAI_CODEX_TOKEN_URL,
  persistOpenAICodexAuth,
} from "@/lib/provider/openai-codex-auth";
import {
  type CodexDeviceLoginClock,
  OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_USER_CODE_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URI,
  startOpenAICodexDeviceLogin,
} from "@/lib/provider/openai-codex-device-login";
import {
  assert,
  assertEqual,
  isRecord,
  withTempDir,
} from "@/lib/verification/harness";

await withTempDir("sandi-codex-device-login-", async (dir) => {
  await verifySuccessfulDeviceLoginPersistsAuth(dir);
  await verifyPendingThenAuthorized();
  await verifyTimeout();
  await verifyCancel();
  await verifyFailedPoll();
  await verifyUserCodeFailure();
  console.log("OpenAI Codex device login verification passed");
});

async function verifySuccessfulDeviceLoginPersistsAuth(
  dir: string,
): Promise<void> {
  const agentDir = join(dir, "jess");
  const pending = await startOpenAICodexDeviceLogin({
    fetch: scriptedFetch([
      {
        url: OPENAI_CODEX_DEVICE_USER_CODE_URL,
        response: jsonResponse({
          device_auth_id: "dev-1",
          user_code: "WXYZ-1234",
          interval: "1",
        }),
      },
      {
        url: OPENAI_CODEX_DEVICE_TOKEN_URL,
        response: jsonResponse({
          authorization_code: "auth-code",
          code_verifier: "verifier",
        }),
      },
      {
        url: OPENAI_CODEX_TOKEN_URL,
        response: jsonResponse({
          access_token: fakeAccessToken("acct-jess"),
          refresh_token: "refresh-jess",
          expires_in: 3600,
        }),
      },
    ]),
    clock: fakeClock(),
  });

  assertEqual(pending.userCode, "WXYZ-1234", "user code from device auth");
  assertEqual(
    pending.verificationUri,
    OPENAI_CODEX_DEVICE_VERIFICATION_URI,
    "verification URL is the ChatGPT device page",
  );
  assertEqual(
    pending.expiresInSeconds,
    OPENAI_CODEX_DEVICE_TIMEOUT_SECONDS,
    "device codes expire after 15 minutes",
  );

  const completion = await pending.complete();
  assertEqual(completion.kind, "authorized", "device login completes");
  if (completion.kind !== "authorized") return;

  await persistOpenAICodexAuth({
    agentDir,
    credential: completion.credential,
  });
  const written = record(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")),
  );
  const codex = record(written["openai-codex"]);
  assertEqual(codex["type"], "oauth", "saved credential is oauth");
  assertEqual(codex["accountId"], "acct-jess", "saved chatgpt account id");
  assertEqual(codex["refresh"], "refresh-jess", "saved refresh token");
}

async function verifyPendingThenAuthorized(): Promise<void> {
  let polls = 0;
  const pending = await startOpenAICodexDeviceLogin({
    fetch: async (url) => {
      if (url === OPENAI_CODEX_DEVICE_USER_CODE_URL) {
        return jsonResponse({
          device_auth_id: "dev-2",
          user_code: "PEND-0001",
          interval: 1,
        });
      }
      if (url === OPENAI_CODEX_DEVICE_TOKEN_URL) {
        polls += 1;
        if (polls < 3) return new Response(null, { status: 403 });
        return jsonResponse({
          authorization_code: "auth-code",
          code_verifier: "verifier",
        });
      }
      return jsonResponse({
        access_token: fakeAccessToken("acct-2"),
        refresh_token: "refresh-2",
        expires_in: 10,
      });
    },
    clock: fakeClock(),
  });
  const completion = await pending.complete();
  assertEqual(
    completion.kind,
    "authorized",
    "login succeeds after pending polls",
  );
  assertEqual(polls, 3, "polls until ChatGPT authorizes the device");
}

async function verifyTimeout(): Promise<void> {
  const pending = await startOpenAICodexDeviceLogin({
    fetch: async (url) => {
      if (url === OPENAI_CODEX_DEVICE_USER_CODE_URL) {
        return jsonResponse({
          device_auth_id: "dev-timeout",
          user_code: "TIME-OUT1",
          interval: 5,
        });
      }
      return new Response(null, { status: 403 });
    },
    clock: fakeClock(),
  });
  const completion = await pending.complete();
  assertEqual(completion.kind, "timeout", "unconfirmed device codes time out");
}

async function verifyCancel(): Promise<void> {
  const pending = await startOpenAICodexDeviceLogin({
    fetch: async (url) => {
      if (url === OPENAI_CODEX_DEVICE_USER_CODE_URL) {
        return jsonResponse({
          device_auth_id: "dev-cancel",
          user_code: "CANC-EL01",
          interval: 5,
        });
      }
      return new Response(null, { status: 403 });
    },
    clock: fakeClock(),
  });
  const controller = new AbortController();
  controller.abort();
  const completion = await pending.complete(controller.signal);
  assertEqual(completion.kind, "cancelled", "aborted logins cancel cleanly");
}

async function verifyFailedPoll(): Promise<void> {
  const pending = await startOpenAICodexDeviceLogin({
    fetch: async (url) => {
      if (url === OPENAI_CODEX_DEVICE_USER_CODE_URL) {
        return jsonResponse({
          device_auth_id: "dev-fail",
          user_code: "FAIL-0001",
          interval: 1,
        });
      }
      return new Response("nope", { status: 500 });
    },
    clock: fakeClock(),
  });
  const completion = await pending.complete();
  assertEqual(completion.kind, "failed", "non-pending poll errors fail closed");
  if (completion.kind !== "failed") return;
  assert(
    completion.message.includes("500"),
    "failure message includes the HTTP status",
  );
}

async function verifyUserCodeFailure(): Promise<void> {
  try {
    await startOpenAICodexDeviceLogin({
      fetch: async () => new Response(null, { status: 404 }),
      clock: fakeClock(),
    });
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("not enabled"),
      "missing device-auth endpoint explains the failure",
    );
    return;
  }
  throw new Error("expected device code start to fail on 404");
}

function scriptedFetch(
  steps: readonly { url: string; response: Response }[],
): CodexAuthFetch {
  let index = 0;
  return async (url) => {
    const step = steps[index];
    if (!step) throw new Error(`unexpected extra fetch to ${url}`);
    assertEqual(url, step.url, `fetch ${index} hits the expected endpoint`);
    index += 1;
    return step.response;
  };
}

function fakeClock(): CodexDeviceLoginClock {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) {
        const error = new Error("Login cancelled");
        error.name = "AbortError";
        throw error;
      }
      now += ms;
    },
  };
}

function fakeAccessToken(accountId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected object, got ${JSON.stringify(value)}`);
  }
  return value;
}
