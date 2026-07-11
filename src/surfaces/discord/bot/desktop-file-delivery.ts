import { Buffer } from "node:buffer";

import type { MessageCreateOptions } from "discord.js";

import type { DesktopFileDelivery } from "@/lib/provider/desktop-hands";

export type DesktopFileDeliveryChannel = {
  send(options: MessageCreateOptions): Promise<unknown>;
};

/**
 * Delivers bytes that the turn-scoped broker already authenticated and parsed.
 * Keeping Discord upload construction here leaves the bot orchestration with a
 * single callback and makes upload failure observable by the broker tool call.
 */
export async function deliverDesktopFileToDiscord(input: {
  channel: DesktopFileDeliveryChannel;
  delivery: DesktopFileDelivery;
  replyToMessageId?: string;
}): Promise<void> {
  const options: MessageCreateOptions = {
    allowedMentions: { parse: [], repliedUser: false },
    files: [
      {
        attachment: Buffer.from(input.delivery.attachment.dataBase64, "base64"),
        name: input.delivery.attachment.name,
      },
    ],
  };
  if (input.delivery.content?.trim()) {
    options.content = input.delivery.content.trim();
  }
  if (input.replyToMessageId) {
    options.reply = {
      messageReference: input.replyToMessageId,
      failIfNotExists: false,
    };
  }
  await input.channel.send(options);
}
