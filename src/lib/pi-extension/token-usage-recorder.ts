import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRIVATE_FILE_MODE = 0o600;

export default function (pi: ExtensionAPI): void {
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    const path = process.env["SANDI_TOKEN_USAGE_PATH"]?.trim();
    if (!path) return;

    await appendUsageRecord(path, event.message);
  });
}

async function appendUsageRecord(
  path: string,
  message: AssistantMessage,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const usage = message.usage;
  const record = {
    v: 1,
    timestamp: new Date().toISOString(),
    conversationId: process.env["SANDI_CONVERSATION_ID"]?.trim(),
    sessionMode: process.env["SANDI_SESSION_MODE"]?.trim(),
    accountId: process.env["SANDI_PI_ACCOUNT_ID"]?.trim(),
    provider: message.provider,
    model: message.model,
    configuredProvider: process.env["SANDI_PI_PROVIDER"]?.trim(),
    configuredModel: process.env["SANDI_PI_MODEL"]?.trim(),
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.totalTokens,
      cost: usage.cost.total,
    },
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  if (process.platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
}
