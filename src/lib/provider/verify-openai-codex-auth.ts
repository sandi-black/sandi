import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type CodexAuthFetch,
  loadOpenAICodexAuth,
  persistOpenAICodexAuth,
} from "@/lib/provider/openai-codex-auth";
import { assertEqual, isRecord, withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-codex-auth-", async (dir) => {
  await verifyPersistMergesExistingProviders(dir);
  await verifyLoadRefreshesExpiredToken(dir);
  await verifyLoadAcceptsLegacyCredentialWithoutType(dir);
  console.log("OpenAI Codex auth verification passed");
});

async function verifyPersistMergesExistingProviders(
  dir: string,
): Promise<void> {
  const agentDir = join(dir, "merge-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({ anthropic: { type: "oauth", access: "keep-me" } }, null, 2)}\n`,
    "utf8",
  );

  await persistOpenAICodexAuth({
    agentDir,
    credential: {
      type: "oauth",
      access: fakeAccessToken("acct-1"),
      refresh: "refresh-1",
      expires: 1_700_000_000_000,
      accountId: "acct-1",
    },
  });

  const written = record(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")),
  );
  assertEqual(
    written["anthropic"],
    { type: "oauth", access: "keep-me" },
    "persist keeps other provider credentials",
  );
  const codex = record(written["openai-codex"]);
  assertEqual(
    codex["type"],
    "oauth",
    "persist writes Pi oauth credential type",
  );
  assertEqual(
    codex["accountId"],
    "acct-1",
    "persist writes chatgpt account id",
  );
  assertEqual(codex["refresh"], "refresh-1", "persist writes refresh token");
}

async function verifyLoadRefreshesExpiredToken(dir: string): Promise<void> {
  const agentDir = join(dir, "refresh-agent");
  await persistOpenAICodexAuth({
    agentDir,
    credential: {
      type: "oauth",
      access: fakeAccessToken("acct-old"),
      refresh: "stale-refresh",
      expires: 1_000,
      accountId: "acct-old",
    },
  });

  const fetchImpl: CodexAuthFetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    assertEqual(
      body.includes("grant_type=refresh_token"),
      true,
      "expired auth refreshes with refresh_token grant",
    );
    assertEqual(
      body.includes("refresh_token=stale-refresh"),
      true,
      "refresh uses the stored refresh token",
    );
    return jsonResponse({
      access_token: fakeAccessToken("acct-new"),
      refresh_token: "fresh-refresh",
      expires_in: 60,
    });
  };

  const loaded = await loadOpenAICodexAuth({
    agentDir,
    now: 50_000,
    fetch: fetchImpl,
  });

  assertEqual(
    loaded.accountId,
    "acct-new",
    "refresh updates chatgpt account id",
  );
  assertEqual(loaded.refresh, "fresh-refresh", "refresh stores rotated token");
  assertEqual(loaded.expires, 110_000, "refresh computes expiry from now");

  const written = record(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")),
  );
  assertEqual(
    record(written["openai-codex"])["refresh"],
    "fresh-refresh",
    "refresh writes the new credential back to auth.json",
  );
}

async function verifyLoadAcceptsLegacyCredentialWithoutType(
  dir: string,
): Promise<void> {
  const agentDir = join(dir, "legacy-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify({
      "openai-codex": {
        access: fakeAccessToken("acct-legacy"),
        refresh: "legacy-refresh",
        expires: 9_999_999_999_000,
      },
    })}\n`,
    "utf8",
  );

  const loaded = await loadOpenAICodexAuth({ agentDir, now: 1_000 });
  assertEqual(loaded.type, "oauth", "legacy credentials normalize to oauth");
  assertEqual(
    loaded.accountId,
    "acct-legacy",
    "legacy credentials derive chatgpt account id from the access token",
  );
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
