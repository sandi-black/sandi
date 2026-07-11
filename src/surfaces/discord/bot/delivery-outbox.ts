import { createHash } from "node:crypto";

import type { MessageCreateOptions } from "discord.js";

import { z } from "zod/v4";
import {
  AmbiguousDeliveryError,
  type DeliveryRecord,
  type DurableOutbox,
} from "@/lib/delivery/outbox";
import { errorMessage } from "@/lib/errors";

export const DISCORD_MESSAGE_DELIVERY = "discord-message-v1";

const DiscordMessagePayloadSchema = z.object({
  channelId: z.string().min(1),
  chunks: z.array(z.string().min(1)).min(1),
  replyToMessageId: z.string().min(1).optional(),
});
const DiscordMessageProgressSchema = z.object({
  nextChunk: z.number().int().nonnegative(),
  messageIds: z.array(z.string().min(1)),
});

export type DiscordMessagePayload = z.infer<typeof DiscordMessagePayloadSchema>;
export type DiscordMessageSender = (
  channelId: string,
  options: MessageCreateOptions,
) => Promise<{ id: string }>;

export function registerDiscordMessageDelivery(
  outbox: DurableOutbox,
  send: DiscordMessageSender,
): void {
  outbox.register(DISCORD_MESSAGE_DELIVERY, async (record, signal) => {
    signal.throwIfAborted();
    const payload = DiscordMessagePayloadSchema.parse(record.payload);
    const progress = DiscordMessageProgressSchema.parse(
      record.progress ?? { nextChunk: 0, messageIds: [] },
    );
    const chunk = payload.chunks[progress.nextChunk];
    if (chunk === undefined) {
      return {
        status: "complete",
        result: { messageIds: progress.messageIds },
      };
    }
    const options: MessageCreateOptions = {
      content: chunk,
      allowedMentions: { parse: [], repliedUser: false },
      nonce: discordNonce(record, progress.nextChunk),
      enforceNonce: true,
    };
    if (progress.nextChunk === 0 && payload.replyToMessageId) {
      options.reply = {
        messageReference: payload.replyToMessageId,
        failIfNotExists: false,
      };
    }
    let message: { id: string };
    try {
      message = await send(payload.channelId, options);
    } catch (error) {
      // Discord may have accepted the POST before the connection failed. Retry
      // the same chunk with the same enforced nonce so Discord can deduplicate
      // it during its nonce window; after that window the outbox remains
      // explicitly at-least-once rather than silently losing the response.
      throw new AmbiguousDeliveryError(errorMessage(error), { cause: error });
    }
    const next = {
      nextChunk: progress.nextChunk + 1,
      messageIds: [...progress.messageIds, message.id],
    };
    if (next.nextChunk < payload.chunks.length) {
      return { status: "progress", progress: next };
    }
    return { status: "complete", result: { messageIds: next.messageIds } };
  });
}

export async function enqueueDiscordMessage(input: {
  outbox: DurableOutbox;
  idempotencyKey: string;
  payload: DiscordMessagePayload;
}): Promise<void> {
  const record = await input.outbox.enqueue({
    idempotencyKey: input.idempotencyKey,
    kind: DISCORD_MESSAGE_DELIVERY,
    payload: DiscordMessagePayloadSchema.parse(input.payload),
  });
  if (
    !input.outbox.isDelivering() &&
    (record.status === "pending" || record.status === "processing")
  ) {
    await input.outbox.deliverNow(input.idempotencyKey);
  }
}

function discordNonce(record: DeliveryRecord, index: number): string {
  return createHash("sha256")
    .update(`${record.idempotencyKey}:${index}`)
    .digest("hex")
    .slice(0, 24);
}
