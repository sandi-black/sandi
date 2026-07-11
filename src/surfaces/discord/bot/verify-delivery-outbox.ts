import assert from "node:assert/strict";
import { join } from "node:path";

import type { MessageCreateOptions } from "discord.js";

import { DurableOutbox } from "@/lib/delivery/outbox";
import { withTempDir } from "@/lib/verification/harness";
import {
  enqueueDiscordMessage,
  registerDiscordMessageDelivery,
} from "@/surfaces/discord/bot/delivery-outbox";

await withTempDir("sandi-discord-outbox-", async (root) => {
  let now = Date.parse("2026-07-10T04:00:00.000Z");
  const outbox = new DurableOutbox(join(root, "outbox.json"), {
    now: () => now,
    retryBaseMs: 10,
    retryMaxMs: 100,
    claimLeaseMs: 100,
    pollMaxMs: 100,
  });
  const calls: MessageCreateOptions[] = [];
  const messages = new Map<string, { id: string }>();
  registerDiscordMessageDelivery(outbox, async (_channelId, options) => {
    calls.push(options);
    const nonce = String(options.nonce);
    const existing = messages.get(nonce);
    if (existing) return existing;
    const message = { id: `message-${messages.size + 1}` };
    messages.set(nonce, message);
    if (calls.length === 1) throw new Error("acknowledgement was lost");
    return message;
  });

  await enqueueDiscordMessage({
    outbox,
    idempotencyKey: "discord:response:ada-message",
    payload: {
      channelId: "channel-1",
      chunks: ["first", "second"],
      replyToMessageId: "ada-message",
    },
  });
  assert.equal(
    (await outbox.get("discord:response:ada-message"))?.lastError?.class,
    "ambiguous",
  );
  now += 10;
  const record = await outbox.deliverNow("discord:response:ada-message");
  assert.equal(record?.status, "completed");
  assert.equal(record?.attempts, 3);
  assert.equal(messages.size, 2, "the enforced nonce deduplicates the retry");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.nonce, calls[1]?.nonce);
  assert.notEqual(calls[1]?.nonce, calls[2]?.nonce);
  assert.equal(calls[0]?.enforceNonce, true);
  assert(calls[0]?.reply, "the first chunk preserves its reply target");
  assert.equal(calls[2]?.reply, undefined);
});

console.log("Discord delivery outbox verification passed");
