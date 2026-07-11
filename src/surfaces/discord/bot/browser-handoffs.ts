import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import type { BrowserUseService } from "@/lib/browser-use/service";
import type { AwaitingHumanSession } from "@/lib/browser-use/state";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";

const log = createLogger("browser-handoffs");

export type BrowserHandoffDecision = {
  action: "continue" | "cancel";
  sessionId: string;
  conversationId: string;
  channelId: string;
  discordUserId: string;
  promptMessageId?: string;
};

export class BrowserHandoffManager {
  readonly #client: Client;
  readonly #service: BrowserUseService;
  readonly #onDecision: (decision: BrowserHandoffDecision) => Promise<void>;

  constructor(input: {
    client: Client;
    service: BrowserUseService;
    onDecision: (decision: BrowserHandoffDecision) => Promise<void>;
  }) {
    this.#client = input.client;
    this.#service = input.service;
    this.#onDecision = input.onDecision;
  }

  async publishPending(conversationId: string): Promise<void> {
    const handoffs =
      await this.#service.store.pendingDiscordHandoffs(conversationId);
    for (const session of handoffs) {
      const channel = await this.#client.channels.fetch(
        session.handoff.surfaceTargetId,
      );
      if (!channel?.isSendable()) {
        throw new Error(
          `Browser handoff channel ${session.handoff.surfaceTargetId} is unavailable`,
        );
      }
      const message = await channel.send({
        content: `<@${session.handoff.requesterPlatformUserId}>, a private browser handoff is ready.`,
        components: [openHandoffRow(session.id)],
        allowedMentions: {
          users: [session.handoff.requesterPlatformUserId],
        },
      });
      await this.#service.markHandoffPromptSent(session.id, message.id);
    }
  }

  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton()) return false;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return false;

    try {
      if (parsed.action === "open") {
        const [session, liveUrl] = await Promise.all([
          this.#service.requireHandoff({
            sessionId: parsed.sessionId,
            requesterPlatformUserId: interaction.user.id,
          }),
          this.#service.liveUrl({
            sessionId: parsed.sessionId,
            requesterPlatformUserId: interaction.user.id,
          }),
        ]);
        await interaction.reply({
          content: [
            session.handoff.reason,
            "",
            `This private browser closes automatically <t:${Math.floor(new Date(session.handoff.expiresAt).getTime() / 1_000)}:R>. Choose Continue when the browser is ready, or Cancel to stop the request and save the profile now.`,
          ].join("\n"),
          components: [privateHandoffRow(session.id, liveUrl)],
          allowedMentions: { parse: [] },
          ephemeral: true,
        });
        return true;
      }

      const handoff = await this.#service.requireHandoff({
        sessionId: parsed.sessionId,
        requesterPlatformUserId: interaction.user.id,
        allowExpired: parsed.action === "cancel",
      });
      const decision = decisionFrom(handoff, parsed.action);

      if (parsed.action === "continue") {
        await this.#service.acceptHandoff({
          sessionId: parsed.sessionId,
          requesterPlatformUserId: interaction.user.id,
        });
        await interaction.update({
          content: "Continuing the browser task.",
          components: [],
          allowedMentions: { parse: [] },
        });
      } else {
        await this.#service.cancelHandoff({
          sessionId: parsed.sessionId,
          requesterPlatformUserId: interaction.user.id,
        });
        await interaction.update({
          content: "Canceled. The browser is closed and its profile was saved.",
          components: [],
          allowedMentions: { parse: [] },
        });
      }
      await this.#onDecision(decision);
      return true;
    } catch (error) {
      log.warn("failed to handle browser handoff interaction", {
        sessionId: parsed.sessionId,
        action: parsed.action,
        error: errorMessage(error),
      });
      const content =
        "This private browser handoff is unavailable or has expired. The session will be cleaned up automatically.";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content,
          allowedMentions: { parse: [] },
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content,
          allowedMentions: { parse: [] },
          ephemeral: true,
        });
      }
      return true;
    }
  }
}

function openHandoffRow(
  sessionId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bh:open:${sessionId}`)
      .setLabel("Open secure browser handoff")
      .setStyle(ButtonStyle.Primary),
  );
}

function privateHandoffRow(
  sessionId: string,
  liveUrl: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open browser")
      .setStyle(ButtonStyle.Link)
      .setURL(liveUrl),
    new ButtonBuilder()
      .setCustomId(`bh:continue:${sessionId}`)
      .setLabel("Continue")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`bh:cancel:${sessionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
}

function parseCustomId(
  customId: string,
): { action: "open" | "continue" | "cancel"; sessionId: string } | undefined {
  const match = /^bh:(open|continue|cancel):([0-9a-f-]{36})$/u.exec(customId);
  if (!match) return undefined;
  const action = match[1];
  const sessionId = match[2];
  if (
    (action !== "open" && action !== "continue" && action !== "cancel") ||
    sessionId === undefined
  ) {
    return undefined;
  }
  return { action, sessionId };
}

function decisionFrom(
  session: AwaitingHumanSession,
  action: "continue" | "cancel",
): BrowserHandoffDecision {
  return {
    action,
    sessionId: session.id,
    conversationId: session.conversationId,
    channelId: session.handoff.surfaceTargetId,
    discordUserId: session.handoff.requesterPlatformUserId,
    ...(session.handoff.promptMessageId
      ? { promptMessageId: session.handoff.promptMessageId }
      : {}),
  };
}
