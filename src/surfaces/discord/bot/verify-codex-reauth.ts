import { join } from "node:path";

import type { HumanIdentityConfig } from "@/lib/identity/types";
import type { OpenAICodexOAuthCredential } from "@/lib/provider/openai-codex-auth";
import type { PiAccountRoutingConfig } from "@/lib/provider/pi-account-routing";
import { assertEqual } from "@/lib/verification/harness";
import {
  codexReauthDeclineMessage,
  formatCodexReauthCompletion,
  formatCodexReauthPrompt,
  resolveCodexReauthTarget,
} from "@/surfaces/discord/bot/codex-reauth";

const IDENTITIES: HumanIdentityConfig = {
  version: 1,
  humans: [
    {
      id: "jess",
      displayName: "Jess",
      platforms: { discord: { id: "111", username: "jess" } },
    },
    {
      id: "unmapped",
      displayName: "Unmapped",
      platforms: { discord: { id: "222", username: "unmapped" } },
    },
    {
      id: "legacy",
      displayName: "Legacy",
      platforms: { discord: { username: "legacy" } },
    },
  ],
};

const ROUTING: PiAccountRoutingConfig = {
  accounts: [
    {
      id: "jess-codex",
      displayName: "Jess",
      agentDir: "/tmp/pi-accounts/jess",
    },
  ],
  routes: [{ identityId: "jess", accountId: "jess-codex" }],
};

function verifyCodexReauth(): void {
  verifyRecognizedMappedUser();
  verifyMissingAuthJsonStillResolves();
  verifyUnknownAndIdlessUsersDeclined();
  verifyUnmappedIdentityDeclinedWhenRoutingExists();
  verifyDefaultAgentDirWithoutRouting();
  verifyPromptAndCompletionCopy();
  console.log("codex reauth verification passed");
}

function verifyRecognizedMappedUser(): void {
  const target = resolveCodexReauthTarget({
    identities: IDENTITIES,
    routing: ROUTING,
    discordUserId: "111",
  });
  if (!target.ok) {
    throw new Error("expected Jess to resolve to her routed Pi account");
  }
  assertEqual(target.identityId, "jess", "resolved identity");
  assertEqual(target.accountId, "jess-codex", "resolved Pi account");
  assertEqual(target.accountLabel, "Jess", "account label");
  assertEqual(target.agentDir, "/tmp/pi-accounts/jess", "account agent dir");
}

function verifyMissingAuthJsonStillResolves(): void {
  const target = resolveCodexReauthTarget({
    identities: IDENTITIES,
    routing: {
      accounts: [
        {
          id: "jess-codex",
          displayName: "Jess",
          agentDir: join("/does-not-exist", "jess"),
        },
      ],
      routes: [{ identityId: "jess", accountId: "jess-codex" }],
    },
    discordUserId: "111",
  });
  if (!target.ok) {
    throw new Error("reauth must work even when auth.json is missing");
  }
  assertEqual(
    target.agentDir,
    join("/does-not-exist", "jess"),
    "missing auth.json does not hide the routed account",
  );
}

function verifyUnknownAndIdlessUsersDeclined(): void {
  const unknown = resolveCodexReauthTarget({
    identities: IDENTITIES,
    routing: ROUTING,
    discordUserId: "999",
  });
  assertEqual(unknown.ok, false, "unknown Discord id is declined");
  if (unknown.ok) return;
  assertEqual(unknown.reason, "unrecognized", "unknown reason");

  const idless = resolveCodexReauthTarget({
    identities: IDENTITIES,
    routing: ROUTING,
    discordUserId: "legacy",
  });
  assertEqual(idless.ok, false, "id-less identity is declined");
}

function verifyUnmappedIdentityDeclinedWhenRoutingExists(): void {
  const target = resolveCodexReauthTarget({
    identities: IDENTITIES,
    routing: ROUTING,
    discordUserId: "222",
  });
  assertEqual(target.ok, false, "unmapped identity is declined");
  if (target.ok) return;
  assertEqual(target.reason, "unmapped", "unmapped reason");
  assertEqual(
    codexReauthDeclineMessage(target.reason).includes("routed"),
    true,
    "unmapped copy tells the user to add routing",
  );
}

function verifyDefaultAgentDirWithoutRouting(): void {
  const target = resolveCodexReauthTarget({
    identities: IDENTITIES,
    defaultAgentDir: "/tmp/default-pi",
    discordUserId: "111",
  });
  if (!target.ok) {
    throw new Error("recognized users can reauth the default Pi dir");
  }
  assertEqual(target.accountId, "default", "no-routing account id");
  assertEqual(target.agentDir, "/tmp/default-pi", "default agent dir");
}

function verifyPromptAndCompletionCopy(): void {
  const prompt = formatCodexReauthPrompt({
    accountLabel: "Jess",
    userCode: "WXYZ-1234",
    verificationUri: "https://auth.openai.com/codex/device",
    expiresInSeconds: 900,
  });
  assertEqual(prompt.includes("WXYZ-1234"), true, "prompt includes user code");
  assertEqual(
    prompt.includes("https://auth.openai.com/codex/device"),
    true,
    "prompt includes device URL",
  );

  assertEqual(
    formatCodexReauthCompletion({ kind: "timeout" }, "Jess").includes(
      "/sandi reauth",
    ),
    true,
    "timeout copy points back at /sandi reauth",
  );
  assertEqual(
    formatCodexReauthCompletion(
      { kind: "authorized", credential: dummyCredential() },
      "Jess",
    ).includes("Jess"),
    true,
    "success copy names the account",
  );
}

function dummyCredential(): OpenAICodexOAuthCredential {
  return {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 1,
    accountId: "acct",
  };
}

verifyCodexReauth();
