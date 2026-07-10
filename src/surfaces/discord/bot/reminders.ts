import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";

import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { isRecord } from "@/lib/type-guards";
import type { EventTarget } from "@/surfaces/discord/events/schemas";
import { completedReminder } from "@/surfaces/discord/reminders/recurrence";
import type {
  Reminder,
  ReminderMessageRef,
  ReminderUser,
} from "@/surfaces/discord/reminders/schemas";
import {
  listReminders,
  readReminder,
  type StoredReminder,
  writeReminder,
} from "@/surfaces/discord/reminders/store";
import {
  type ReminderTrigger,
  ReminderWatcher,
} from "@/surfaces/discord/reminders/watcher";
import {
  formatTargetLabel,
  targetMatches,
} from "@/surfaces/discord/shared/targets";

const log = createLogger("reminders");
const MAX_REMINDER_MESSAGES_TRACKED = 20;
const MAX_REMINDERS_DISPLAYED = 10;
const MIN_FOLLOWUP_INTERVAL_MINUTES = 60;
const MAX_REMINDER_FIRES_PER_24_HOURS = 3;
const REMINDER_FIRE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CLEAN_HANDLED_CHANNEL_NAMES = new Set(readCleanHandledChannelNames());
const CLEAN_HANDLED_CHANNEL_PREFIXES = ["todo-", "tasks-"] as const;
const MAX_INTERACTION_RESPONSE_CHARS = 2_000;
const SNOOZE_OPTIONS = [
  { label: "1 hour", value: "60", description: "Remind again in 1 hour" },
  { label: "6 hours", value: "360", description: "Remind again in 6 hours" },
  { label: "12 hours", value: "720", description: "Remind again in 12 hours" },
  { label: "24 hours", value: "1440", description: "Remind again in 24 hours" },
  { label: "1 week", value: "10080", description: "Remind again in 1 week" },
] as const;

type ReminderDoneHandler = (input: {
  id: string;
  reminder: Reminder;
  updated: Reminder;
}) => Promise<void>;

export class ReminderManager {
  readonly #client: Client;
  readonly #remindersRoot: string;
  readonly #watcher: ReminderWatcher;
  readonly #onReminderDone: ReminderDoneHandler | undefined;

  constructor(input: {
    client: Client;
    remindersRoot: string;
    onReminderDone?: ReminderDoneHandler;
  }) {
    this.#client = input.client;
    this.#remindersRoot = input.remindersRoot;
    this.#onReminderDone = input.onReminderDone;
    this.#watcher = new ReminderWatcher(input.remindersRoot, (trigger) => {
      void this.#fireReminder(trigger);
    });
  }

  async start(): Promise<void> {
    await this.#watcher.start();
  }

  stop(): void {
    this.#watcher.stop();
  }

  async handleInteraction(interaction: Interaction): Promise<boolean> {
    try {
      if (interaction.isButton()) {
        const parsed = parseReminderCustomId(interaction.customId);
        if (!parsed) return false;
        if (parsed.action === "done") {
          await this.#markDone(interaction, parsed.id);
          return true;
        }
        if (parsed.action === "snooze") {
          await interaction.reply({
            content: "Snooze this reminder for:",
            components: [snoozeSelectRow(parsed.id)],
            ephemeral: true,
          });
          return true;
        }
        if (parsed.action === "delete") {
          await interaction.reply({
            content:
              "Delete this reminder? This only affects the new reminder object; it will not touch old scheduled events.",
            components: [deleteConfirmRow(parsed.id)],
            ephemeral: true,
          });
          return true;
        }
        if (parsed.action === "delete-confirm") {
          await this.#deleteConfirmed(interaction, parsed.id);
          return true;
        }
        if (parsed.action === "delete-cancel") {
          await interaction.update({
            content: "Kept the reminder.",
            components: [],
          });
          return true;
        }
      }

      if (interaction.isStringSelectMenu()) {
        const parsed = parseReminderCustomId(interaction.customId);
        if (parsed?.action !== "snooze-select") return false;
        const selected = interaction.values[0];
        if (!selected) {
          await interaction.update({
            content: "No snooze duration was selected.",
            components: [],
          });
          return true;
        }
        await this.#snooze(interaction, parsed.id, selected);
        return true;
      }
    } catch (error) {
      log.warn("failed to handle reminder interaction", {
        error: errorMessage(error),
      });
      await respondToInteractionFailure(interaction);
      return true;
    }

    return false;
  }

  async listForTarget(input: {
    target: EventTarget | undefined;
    scope: "all" | "current";
  }): Promise<StoredReminder[]> {
    const reminders = await listReminders(this.#remindersRoot);
    const target = input.target;
    if (input.scope === "all" || !target) return reminders;
    return reminders.filter((item) => targetMatches(item.reminder, target));
  }

  formatList(input: {
    reminders: StoredReminder[];
    scope: "all" | "current";
    currentTarget: EventTarget | undefined;
    totalReminders: number;
  }): string {
    const heading =
      input.scope === "all"
        ? `🔔 Reminders — all (${input.totalReminders})`
        : `🔔 Reminders — ${formatTargetLabel(input.currentTarget)}`;
    if (input.reminders.length === 0) return `${heading}\nNo reminders found.`;

    const lines = [heading];
    for (const item of input.reminders.slice(0, MAX_REMINDERS_DISPLAYED)) {
      lines.push(formatReminderLine(item, input.scope));
    }
    const hidden = input.reminders.length - MAX_REMINDERS_DISPLAYED;
    if (hidden > 0) lines.push(`…and ${hidden} more.`);
    return limitText(lines.join("\n"), MAX_INTERACTION_RESPONSE_CHARS);
  }

  async #fireReminder(trigger: ReminderTrigger): Promise<void> {
    let reminder: Reminder;
    try {
      reminder = await readReminder(this.#remindersRoot, trigger.id);
    } catch (error) {
      log.warn("reminder disappeared before firing", {
        id: trigger.id,
        error: errorMessage(error),
      });
      return;
    }
    if (reminder.status !== "active") return;

    const now = new Date();
    const recentFireAts = recentReminderFireAts(reminder, now);
    const nextAllowedFireAt = nextAllowedReminderFireAt(recentFireAts);
    if (nextAllowedFireAt && nextAllowedFireAt.getTime() > now.getTime()) {
      await writeReminder(this.#remindersRoot, trigger.id, {
        ...reminder,
        nextFireAt: nextAllowedFireAt.toISOString(),
        recentFireAts,
        followupIntervalMinutes: normalizeFollowupIntervalMinutes(
          reminder.followupIntervalMinutes,
        ),
      });
      return;
    }

    const channel = await this.#fetchReminderTarget(trigger.id, reminder);
    if (!channel) return;

    let message: Message;
    try {
      message = await channel.send(buildReminderMessage(trigger.id, reminder));
    } catch (error) {
      log.error("failed to send reminder", {
        id: trigger.id,
        error: errorMessage(error),
      });
      return;
    }

    let current: Reminder;
    try {
      current = await readReminder(this.#remindersRoot, trigger.id);
    } catch {
      await disableMessage(message, trigger.id);
      return;
    }
    if (current.status !== "active") {
      await disableMessage(message, trigger.id);
      return;
    }

    const followupIntervalMinutes = normalizeFollowupIntervalMinutes(
      current.followupIntervalMinutes,
    );
    const nextFireAt = addMinutes(now, followupIntervalMinutes).toISOString();
    await writeReminder(this.#remindersRoot, trigger.id, {
      ...current,
      nextFireAt,
      lastFiredAt: now.toISOString(),
      recentFireAts: appendRecentReminderFireAt(current.recentFireAts, now),
      followupIntervalMinutes,
      fireCount: current.fireCount + 1,
      messageRefs: appendMessageRef(current.messageRefs, {
        channelId: message.channelId,
        messageId: message.id,
      }),
    });
  }

  async #markDone(interaction: ButtonInteraction, id: string): Promise<void> {
    const reminder = await readReminder(this.#remindersRoot, id);
    if (reminder.status === "done") {
      await interaction.reply({
        content: "That reminder is already done.",
        ephemeral: true,
      });
      return;
    }
    if (reminder.status === "deleted") {
      await interaction.reply({
        content: "That reminder has already been deleted.",
        ephemeral: true,
      });
      return;
    }

    const shouldCleanChannel = await this.#shouldCleanHandledMessages(reminder);
    if (shouldCleanChannel) {
      await interaction.deferUpdate();
      const updated = completedReminder(
        reminder,
        userFromInteraction(interaction),
      );
      await writeReminder(this.#remindersRoot, id, updated);
      await this.#handleReminderDone(id, reminder, updated);
      await this.#deleteTrackedMessages(id, reminder);
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const updated = completedReminder(
      reminder,
      userFromInteraction(interaction),
    );
    await writeReminder(this.#remindersRoot, id, updated);
    await this.#handleReminderDone(id, reminder, updated);
    await this.#disableTrackedMessages(id, reminder);
    await interaction.editReply({
      content: doneInteractionMessage(updated, false),
    });
  }

  async #handleReminderDone(
    id: string,
    reminder: Reminder,
    updated: Reminder,
  ): Promise<void> {
    if (!this.#onReminderDone) return;
    try {
      await this.#onReminderDone({ id, reminder, updated });
    } catch (error) {
      log.warn("failed to run reminder done side effects", {
        id,
        error: errorMessage(error),
      });
    }
  }

  async #snooze(
    interaction: StringSelectMenuInteraction,
    id: string,
    rawMinutes: string,
  ): Promise<void> {
    const minutes = parsePositiveInteger(rawMinutes);
    if (!minutes) {
      await interaction.update({
        content: "That snooze duration was not valid.",
        components: [],
      });
      return;
    }
    const reminder = await readReminder(this.#remindersRoot, id);
    if (reminder.status !== "active") {
      await interaction.update({
        content: `That reminder is already ${reminder.status}.`,
        components: [],
      });
      return;
    }

    const snoozedUntil = addMinutes(new Date(), minutes).toISOString();
    const updated: Reminder = {
      ...reminder,
      nextFireAt: snoozedUntil,
      snoozedUntil,
    };
    await writeReminder(this.#remindersRoot, id, updated);
    if (await this.#shouldCleanHandledMessages(reminder)) {
      await this.#deleteTrackedMessages(id, reminder);
      await interaction.update({ content: "Snoozed.", components: [] });
      await deleteEphemeralReply(interaction);
      return;
    }
    await this.#disableTrackedMessages(id, updated);
    await interaction.update({
      content: `Snoozed until ${inlineCode(snoozedUntil)}.`,
      components: [],
    });
  }

  async #deleteConfirmed(
    interaction: ButtonInteraction,
    id: string,
  ): Promise<void> {
    const reminder = await readReminder(this.#remindersRoot, id);
    if (reminder.status === "deleted") {
      await interaction.update({
        content: "That reminder was already deleted.",
        components: [],
      });
      return;
    }

    const updated: Reminder = {
      ...reminder,
      status: "deleted",
      deletedAt: new Date().toISOString(),
      deletedBy: userFromInteraction(interaction),
    };
    await writeReminder(this.#remindersRoot, id, updated);
    if (await this.#shouldCleanHandledMessages(reminder)) {
      await this.#deleteTrackedMessages(id, reminder);
      await interaction.update({ content: "Deleted.", components: [] });
      await deleteEphemeralReply(interaction);
      return;
    }
    await this.#disableTrackedMessages(id, updated);
    await interaction.update({
      content: "Deleted the reminder. 🗑️",
      components: [],
    });
  }

  async #disableTrackedMessages(id: string, reminder: Reminder): Promise<void> {
    await this.#forEachTrackedMessage(id, reminder, async (message) => {
      await disableMessage(message, id);
    });
  }

  async #deleteTrackedMessages(id: string, reminder: Reminder): Promise<void> {
    await this.#forEachTrackedMessage(id, reminder, async (message) => {
      await deleteMessage(message);
    });
  }

  async #forEachTrackedMessage(
    id: string,
    reminder: Reminder,
    handle: (message: Message) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      reminder.messageRefs.map(async (ref) => {
        try {
          const channel = await this.#client.channels.fetch(ref.channelId);
          const target = asReminderChannel(channel);
          if (!target) return;
          const message = await target.messages.fetch(ref.messageId);
          await handle(message);
        } catch (error) {
          log.warn("failed to update reminder message", {
            id,
            messageId: ref.messageId,
            error: errorMessage(error),
          });
        }
      }),
    );
  }

  async #shouldCleanHandledMessages(reminder: Reminder): Promise<boolean> {
    if (reminder.target.kind !== "channel") return false;
    try {
      const channel = await this.#client.channels.fetch(
        reminder.target.channelId,
      );
      const name = channelName(channel);
      return name ? isCleanHandledChannelName(name) : false;
    } catch {
      return false;
    }
  }

  async #fetchReminderTarget(
    id: string,
    reminder: Reminder,
  ): Promise<ReminderDiscordChannel | undefined> {
    const targetId =
      reminder.target.kind === "thread"
        ? reminder.target.threadId
        : reminder.target.channelId;
    const channel = await this.#client.channels.fetch(targetId);
    const target = asReminderChannel(channel);
    if (!target) {
      log.error("reminder target is not an available text channel", {
        id,
        targetKind: reminder.target.kind,
        targetId,
      });
      return undefined;
    }
    return target;
  }
}

type ReminderDiscordChannel = {
  id: string;
  send(options: MessageCreateOptions): Promise<Message>;
  messages: {
    fetch(messageId: string): Promise<Message>;
  };
};

type ReminderCustomId = {
  action:
    | "done"
    | "snooze"
    | "snooze-select"
    | "delete"
    | "delete-confirm"
    | "delete-cancel";
  id: string;
};

function parseReminderCustomId(customId: string): ReminderCustomId | undefined {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "r") return undefined;
  const action = reminderAction(parts[1]);
  const id = parts[2];
  if (!action || !id) return undefined;
  return { action, id };
}

function reminderAction(
  value: string | undefined,
): ReminderCustomId["action"] | undefined {
  switch (value) {
    case "done":
      return "done";
    case "snz":
      return "snooze";
    case "snzs":
      return "snooze-select";
    case "del":
      return "delete";
    case "delc":
      return "delete-confirm";
    case "delx":
      return "delete-cancel";
    default:
      return undefined;
  }
}

function isCleanHandledChannelName(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return (
    CLEAN_HANDLED_CHANNEL_NAMES.has(normalized) ||
    CLEAN_HANDLED_CHANNEL_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

function readCleanHandledChannelNames(): string[] {
  return (process.env["SANDI_REMINDER_CLEAN_HANDLED_CHANNELS"] ?? "")
    .split(",")
    .map((item) => item.trim().toLocaleLowerCase())
    .filter((item) => item.length > 0);
}

function buildReminderMessage(
  id: string,
  reminder: Reminder,
): MessageCreateOptions {
  const mentionLine = reminder.audienceUserIds
    .map((userId) => `<@${userId}>`)
    .join(" ");
  const title =
    reminder.fireCount > 0 ? "🔔 **Reminder follow-up**" : "🔔 **Reminder**";
  const lines = [mentionLine, title, reminder.text.trim()].filter(
    (line) => line.length > 0,
  );
  if (reminder.fireCount > 0) {
    lines.push(
      `_Follow-up ${reminder.fireCount}; use the buttons below to finish, snooze, or delete it._`,
    );
  } else {
    lines.push("_Use the buttons below to finish, snooze, or delete it._");
  }
  return {
    content: limitText(lines.join("\n"), 1_900),
    components: [reminderButtonRow(id, false)],
    allowedMentions: { users: reminder.audienceUserIds },
  };
}

function reminderButtonRow(
  id: string,
  disabled: boolean,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`r:done:${id}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`r:snz:${id}`)
      .setLabel("Snooze")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`r:del:${id}`)
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function snoozeSelectRow(
  id: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`r:snzs:${id}`)
      .setPlaceholder("Choose a snooze duration")
      .addOptions(...SNOOZE_OPTIONS),
  );
}

function deleteConfirmRow(
  id: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`r:delc:${id}`)
      .setLabel("Yes, delete")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`r:delx:${id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function disableMessage(message: Message, id: string): Promise<void> {
  await message.edit({ components: [reminderButtonRow(id, true)] });
}

async function deleteMessage(message: Message): Promise<void> {
  await message.delete();
}

async function deleteEphemeralReply(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  try {
    await interaction.deleteReply();
  } catch (error) {
    log.warn("failed to delete ephemeral reminder response", {
      error: errorMessage(error),
    });
  }
}

function doneInteractionMessage(reminder: Reminder, removed: boolean): string {
  const prefix = removed ? "Marked done and removed." : "Marked done.";
  if (!reminder.recurrence || reminder.status !== "active")
    return `${prefix} ✅`;
  return `${prefix} Next one is scheduled for ${inlineCode(reminder.nextFireAt)}. ✅`;
}

async function respondToInteractionFailure(
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  const content =
    "I couldn't update that reminder. It may have changed or been removed.";
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}

function appendMessageRef(
  refs: readonly ReminderMessageRef[],
  ref: ReminderMessageRef,
): ReminderMessageRef[] {
  const withoutDuplicate = refs.filter(
    (item) =>
      item.channelId !== ref.channelId || item.messageId !== ref.messageId,
  );
  return [...withoutDuplicate, ref].slice(-MAX_REMINDER_MESSAGES_TRACKED);
}

function userFromInteraction(interaction: Interaction): ReminderUser {
  return userFromDiscordUser(interaction.user, interaction.member);
}

function userFromDiscordUser(user: User, member?: unknown): ReminderUser {
  const reminderUser: ReminderUser = { discordUserId: user.id };
  const username =
    member && isRecord(member) && typeof member["displayName"] === "string"
      ? member["displayName"]
      : (user.globalName ?? user.username);
  if (username) reminderUser.username = username;
  return reminderUser;
}

function formatReminderLine(
  item: StoredReminder,
  scope: "all" | "current",
): string {
  const target =
    scope === "all" ? ` ${formatReminderTarget(item.reminder.target)}` : "";
  return `- ${inlineCode(item.id)} — ${formatReminderStatus(item.reminder)}${target}\n  ${formatReminderSummary(item.reminder.text)}`;
}

function formatReminderStatus(reminder: Reminder): string {
  if (reminder.status === "done") {
    return `done${reminder.doneAt ? ` at ${inlineCode(reminder.doneAt)}` : ""}`;
  }
  if (reminder.status === "deleted") {
    return `deleted${reminder.deletedAt ? ` at ${inlineCode(reminder.deletedAt)}` : ""}`;
  }
  return `active, next ${inlineCode(reminder.nextFireAt)}`;
}

function formatReminderSummary(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return limitText(firstLine ?? "[no reminder text]", 160);
}

function formatReminderTarget(target: Reminder["target"]): string {
  if (target.kind === "thread")
    return `(thread ${inlineCode(target.threadId)})`;
  return `(channel ${inlineCode(target.channelId)})`;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizeFollowupIntervalMinutes(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_FOLLOWUP_INTERVAL_MINUTES) {
    return MIN_FOLLOWUP_INTERVAL_MINUTES;
  }
  return value;
}

function recentReminderFireAts(reminder: Reminder, now: Date): string[] {
  return (reminder.recentFireAts ?? [])
    .filter((iso) => isRecentFireAt(iso, now))
    .sort();
}

function appendRecentReminderFireAt(
  fireAts: readonly string[] | undefined,
  now: Date,
): string[] {
  return [...(fireAts ?? []), now.toISOString()]
    .filter((iso) => isRecentFireAt(iso, now))
    .sort()
    .slice(-MAX_REMINDER_FIRES_PER_24_HOURS);
}

function isRecentFireAt(iso: string, now: Date): boolean {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp < REMINDER_FIRE_LIMIT_WINDOW_MS;
}

function nextAllowedReminderFireAt(
  recentFireAts: readonly string[],
): Date | undefined {
  if (recentFireAts.length < MAX_REMINDER_FIRES_PER_24_HOURS) {
    return undefined;
  }
  const oldestFireAt = recentFireAts[0];
  if (!oldestFireAt) return undefined;
  const oldestTimestamp = new Date(oldestFireAt).getTime();
  if (!Number.isFinite(oldestTimestamp)) return undefined;
  return new Date(oldestTimestamp + REMINDER_FIRE_LIMIT_WINDOW_MS);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function channelName(channel: unknown): string | undefined {
  if (!isRecord(channel)) return undefined;
  const name = channel["name"];
  return typeof name === "string" ? name : undefined;
}

function asReminderChannel(
  channel: unknown,
): ReminderDiscordChannel | undefined {
  if (!isReminderChannel(channel)) return undefined;
  return channel;
}

function isReminderChannel(
  channel: unknown,
): channel is ReminderDiscordChannel {
  if (!isRecord(channel)) return false;
  if (typeof channel["id"] !== "string") return false;
  if (typeof channel["send"] !== "function") return false;
  if (!isRecord(channel["messages"])) return false;
  return typeof channel["messages"]["fetch"] === "function";
}

function inlineCode(value: string): string {
  const compact = value.replaceAll("`", "'").replace(/\s+/g, " ").trim();
  return `\`${limitText(compact || "unknown", 300)}\``;
}

function limitText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
