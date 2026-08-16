import { findHumanIdentityByPlatformId } from "@/lib/identity/resolver";
import type { HumanIdentityConfig } from "@/lib/identity/types";
import { defaultPiAgentDir } from "@/lib/provider/openai-codex-auth";
import type { CodexDeviceLoginCompletion } from "@/lib/provider/openai-codex-device-login";
import {
  PiAccountRouter,
  type PiAccountRoutingConfig,
} from "@/lib/provider/pi-account-routing";

export type CodexReauthTarget =
  | { ok: false; reason: "unrecognized" | "unmapped" }
  | {
      ok: true;
      identityId: string;
      displayName: string;
      accountId: string;
      accountLabel: string;
      agentDir: string;
    };

/**
 * Resolves which Pi/ChatGPT account a Discord user may reauth. Identity matching
 * is auth-grade (immutable Discord account id only). When account routing is
 * configured, the user must have a mapped Pi account; missing auth.json is
 * allowed so a first login or expired refresh token can be replaced. Without
 * routing, a recognized household member reauths the default Pi agent dir.
 */
export function resolveCodexReauthTarget(input: {
  identities: HumanIdentityConfig;
  routing?: PiAccountRoutingConfig;
  defaultAgentDir?: string;
  discordUserId: string;
}): CodexReauthTarget {
  const identity = findHumanIdentityByPlatformId({
    identities: input.identities,
    platform: "discord",
    platformUserId: input.discordUserId,
  });
  if (!identity) return { ok: false, reason: "unrecognized" };

  const fallbackAgentDir = defaultPiAgentDir(input.defaultAgentDir);
  if (!input.routing) {
    return {
      ok: true,
      identityId: identity.id,
      displayName: identity.displayName,
      accountId: "default",
      accountLabel: identity.displayName,
      agentDir: fallbackAgentDir,
    };
  }

  const account = new PiAccountRouter(input.routing).accountForIdentity(
    identity.id,
  );
  if (!account) return { ok: false, reason: "unmapped" };
  return {
    ok: true,
    identityId: identity.id,
    displayName: identity.displayName,
    accountId: account.id,
    accountLabel: account.displayName ?? identity.displayName,
    agentDir: account.agentDir ?? fallbackAgentDir,
  };
}

export function codexReauthDeclineMessage(
  reason: Extract<CodexReauthTarget, { ok: false }>["reason"],
): string {
  switch (reason) {
    case "unrecognized":
      return "I can only refresh ChatGPT/Codex login for a recognized household member, and I do not have you on file yet. Ask an admin to add you (with your Discord account id) to Sandi's identities first.";
    case "unmapped":
      return "I know who you are, but there is no ChatGPT/Codex account routed to you yet. Ask an admin to map your identity in Sandi's Pi account routing before I can refresh this login.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function formatCodexReauthPrompt(input: {
  accountLabel: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}): string {
  const minutes = Math.max(1, Math.round(input.expiresInSeconds / 60));
  return [
    `To refresh the ChatGPT/Codex login for **${input.accountLabel}**:`,
    "",
    `1. Open ${input.verificationUri}`,
    "2. Enter this one-time code:",
    "",
    `\`\`\`\n${input.userCode}\n\`\`\``,
    `It expires in about ${minutes} minutes. I'll wait and save the login to your Sandi Pi account when ChatGPT confirms it. Running this command again replaces any code that's still waiting.`,
  ].join("\n");
}

export function formatCodexReauthCompletion(
  completion: CodexDeviceLoginCompletion,
  accountLabel: string,
): string {
  switch (completion.kind) {
    case "authorized":
      return `Saved a fresh ChatGPT/Codex login for **${accountLabel}**. \`/sandi status\` should show your OpenAI limits again.`;
    case "cancelled":
      return "This ChatGPT login was replaced by a newer `/sandi reauth`.";
    case "timeout":
      return "That ChatGPT device code expired before I saw a login. Run `/sandi reauth` to get a new code.";
    case "failed":
      return `ChatGPT login failed: ${completion.message}`;
    default: {
      const _exhaustive: never = completion;
      return _exhaustive;
    }
  }
}
