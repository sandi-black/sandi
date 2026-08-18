import assert from "node:assert/strict";
import { join } from "node:path";

import { DiscordAPIError, type MessageCreateOptions } from "discord.js";

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

// A malformed reply reference makes Discord answer 400. That record used to
// retry hourly forever because every send failure was treated as ambiguous, so
// pin the rejection to a terminal failure instead.
await withTempDir("sandi-discord-outbox-rejected-", async (root) => {
  const outbox = new DurableOutbox(join(root, "outbox.json"), {
    now: () => Date.parse("2026-08-18T15:00:00.000Z"),
    retryBaseMs: 10,
    retryMaxMs: 100,
    claimLeaseMs: 100,
    pollMaxMs: 100,
  });
  let sends = 0;
  registerDiscordMessageDelivery(outbox, async () => {
    sends += 1;
    throw new DiscordAPIError(
      {
        code: 50035,
        errors: {},
        message: "Invalid Form Body",
      },
      50035,
      400,
      "POST",
      "https://discord.com/api/v10/channels/channel-1/messages",
      {},
    );
  });

  await enqueueDiscordMessage({
    outbox,
    idempotencyKey: "discord:usage-warning:event:grace-hopper-daily:2026-08-18",
    payload: {
      channelId: "channel-1",
      chunks: ["you are close to the usage cap"],
      replyToMessageId: "event:grace-hopper-daily:2026-08-18",
    },
  });

  const record = await outbox.get(
    "discord:usage-warning:event:grace-hopper-daily:2026-08-18",
  );
  assert.equal(record?.status, "failed", "a 400 stops retrying");
  assert.equal(record?.lastError?.class, "permanent");
  assert.equal(record?.ambiguity, undefined);
  assert.equal(sends, 1, "the rejected chunk is never resent");
});

// A rate limit is the one 4xx Discord expects the caller to retry, and a
// dropped connection still leaves delivery genuinely uncertain.
await withTempDir("sandi-discord-outbox-retryable-", async (root) => {
  const outbox = new DurableOutbox(join(root, "outbox.json"), {
    now: () => Date.parse("2026-08-18T15:00:00.000Z"),
    retryBaseMs: 10,
    retryMaxMs: 100,
    claimLeaseMs: 100,
    pollMaxMs: 100,
  });
  registerDiscordMessageDelivery(outbox, async () => {
    throw new DiscordAPIError(
      { code: 0, errors: {}, message: "You are being rate limited." },
      0,
      429,
      "POST",
      "https://discord.com/api/v10/channels/channel-1/messages",
      {},
    );
  });

  await enqueueDiscordMessage({
    outbox,
    idempotencyKey: "discord:response:hopper-message",
    payload: { channelId: "channel-1", chunks: ["hello"] },
  });

  const record = await outbox.get("discord:response:hopper-message");
  assert.equal(record?.status, "pending", "a rate limit keeps retrying");
  assert.equal(record?.lastError?.class, "ambiguous");
});

console.log("Discord delivery outbox verification passed");
