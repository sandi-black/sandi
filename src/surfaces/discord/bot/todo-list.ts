import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  ModalBuilder,
  type ModalSubmitInteraction,
  type SendableChannels,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { z } from "zod/v4";
import { createLogger } from "@/lib/logging";
import { JsonFileStore } from "@/lib/state/file-store";
import {
  nextRecurrenceRun,
  nextReminderRecurrenceRun,
} from "@/surfaces/discord/reminders/recurrence";
import type {
  Reminder,
  ReminderRecurrence,
  ReminderTarget,
  ReminderUser,
} from "@/surfaces/discord/reminders/schemas";
import {
  deleteReminder,
  readReminder,
  writeReminder,
} from "@/surfaces/discord/reminders/store";

const TODO_CHANNEL_NAME = "to-do-list";
const TODO_STATE_PATH = "todo-list/state.json";
const DISCORD_MESSAGE_LIMIT = 2_000;
const DISPLAY_ITEM_LIMIT = 160;
const MAX_TODO_ITEMS = 10;
const MAX_COMPLETION_OPTIONS = 25;
const TODO_TEXT_INPUT_ID = "todo-text";
const TODO_CUSTOM_REMINDER_INPUT_ID = "todo-custom-reminder-at";
const TODO_CUSTOM_REPEAT_INPUT_ID = "todo-custom-repeat";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_DATE_ONLY_REMINDER_HOUR = 9;
const DEFAULT_FOLLOWUP_INTERVAL_MINUTES = 60;
const NTH_TOKEN_PATTERN =
  /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b/giu;
const WEEKDAYS = [
  { cron: "SUN", label: "Sunday", pattern: /\b(?:sun|sunday)s?\b/u },
  { cron: "MON", label: "Monday", pattern: /\b(?:mon|monday)s?\b/u },
  { cron: "TUE", label: "Tuesday", pattern: /\b(?:tue|tues|tuesday)s?\b/u },
  { cron: "WED", label: "Wednesday", pattern: /\b(?:wed|weds|wednesday)s?\b/u },
  {
    cron: "THU",
    label: "Thursday",
    pattern: /\b(?:thu|thur|thurs|thursday)s?\b/u,
  },
  { cron: "FRI", label: "Friday", pattern: /\b(?:fri|friday)s?\b/u },
  { cron: "SAT", label: "Saturday", pattern: /\b(?:sat|saturday)s?\b/u },
] as const;

const log = createLogger("todo-list");

const TodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  authorName: z.string(),
  sourceUrl: z.string().optional(),
  reason: z.string().optional(),
  createdAt: z.string(),
  reminderAt: z.string().optional(),
  reminderRepeat: z.string().optional(),
  reminderId: z.string().optional(),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

const ChannelTodoStateSchema = z.object({
  channelId: z.string(),
  targetKind: z.enum(["channel", "thread"]).optional(),
  title: z.string().optional(),
  instructions: z.string().optional(),
  emptyText: z.string().optional(),
  completionMode: z.enum(["select", "buttons"]).optional(),
  displayMode: z.enum(["default", "grouped-reminders"]).optional(),
  messageId: z.string().optional(),
  items: z.array(TodoItemSchema),
});

type ChannelTodoState = z.infer<typeof ChannelTodoStateSchema>;

const GuildTodoStateSchema = z.object({
  channelId: z.string().optional(),
  messageId: z.string().optional(),
  items: z.array(TodoItemSchema),
  lists: z.record(z.string(), ChannelTodoStateSchema).optional(),
});

type GuildTodoState = z.infer<typeof GuildTodoStateSchema>;

const TodoListStateSchema = z.object({
  guilds: z.record(z.string(), GuildTodoStateSchema),
});

type TodoListState = z.infer<typeof TodoListStateSchema>;

type TodoAction =
  | "add"
  | "complete"
  | "select"
  | "refresh"
  | "modal"
  | "complete-item"
  | "reminder"
  | "repeat"
  | "reminder-custom"
  | "repeat-custom";

type TodoCustomId = {
  action: TodoAction;
  messageId: string;
  itemId?: string;
};

type CreateTodoListResult = {
  messageUrl: string;
  pinned: boolean;
  pinError?: string;
};

type TodoListRef =
  | { kind: "channel"; channelId: string; list: ChannelTodoState }
  | { kind: "legacy"; list: ChannelTodoState };

type AddFromModalResult =
  | { kind: "stale" }
  | { kind: "full" }
  | { kind: "added"; item: TodoItem };

type TodoDestination = TodoListRef & {
  channel?: SendableChannels;
};

type ReminderDateParseResult =
  | { kind: "none" }
  | { kind: "valid"; iso: string }
  | { kind: "invalid"; message: string };

type ReminderRepeatParseResult =
  | { kind: "none" }
  | { kind: "valid"; recurrence: ReminderRecurrence; summary: string }
  | { kind: "invalid"; message: string };

type ReminderPlan = {
  id: string;
  at: string;
  recurrence?: ReminderRecurrence;
  recurrenceSummary?: string;
};

type RepeatTime = {
  hour: number;
  minute: number;
};

type ParsedWeekday = {
  cron: string;
  label: string;
  index: number;
};

const EMPTY_STATE: TodoListState = { guilds: {} };

export class TodoListManager {
  readonly #client: Client;
  readonly #store: JsonFileStore<TodoListState>;
  readonly #remindersRoot: string;

  constructor(input: {
    client: Client;
    dataDir: string;
    remindersRoot: string;
  }) {
    this.#client = input.client;
    this.#remindersRoot = input.remindersRoot;
    this.#store = new JsonFileStore(
      join(input.dataDir, TODO_STATE_PATH),
      TodoListStateSchema,
    );
  }

  async maybeCapture(message: Message): Promise<void> {
    const itemText = extractTodoItem(message.content);
    if (!itemText) return;
    await this.#capture(message, itemText);
  }

  async removeCompletedOneTimeReminder(reminderId: string): Promise<boolean> {
    return await this.#updateState<boolean>(async (state) => {
      let guilds = state.guilds;
      let removed = false;

      for (const [guildId, current] of Object.entries(state.guilds)) {
        let nextGuild = current;
        for (const [channelId, list] of Object.entries(current.lists ?? {})) {
          const items = list.items.filter(
            (item) => !isOneTimeLinkedReminder(item, reminderId),
          );
          if (items.length === list.items.length) continue;

          const updatedList = await this.#upsertRenderedList({
            ...list,
            items,
          });
          nextGuild = updateGuildList(nextGuild, {
            kind: "channel",
            channelId,
            list: updatedList,
          });
          removed = true;
        }

        if (nextGuild.messageId) {
          const legacy = legacyList(nextGuild);
          const items = legacy.items.filter(
            (item) => !isOneTimeLinkedReminder(item, reminderId),
          );
          if (items.length < legacy.items.length) {
            const updatedList = await this.#upsertRenderedList({
              ...legacy,
              items,
            });
            nextGuild = updateGuildList(nextGuild, {
              kind: "legacy",
              list: updatedList,
            });
            removed = true;
          }
        }

        if (nextGuild !== current) {
          guilds = { ...guilds, [guildId]: nextGuild };
        }
      }

      if (!removed) return { result: false };
      return { result: true, next: { guilds } };
    });
  }

  async createPinnedList(
    interaction: ChatInputCommandInteraction,
  ): Promise<CreateTodoListResult | undefined> {
    const channel = interaction.channel;
    const guildId = interaction.guildId;
    if (!guildId || !channel?.isSendable()) return undefined;

    return await this.#updateState<CreateTodoListResult>(async (state) => {
      const current = state.guilds[guildId] ?? emptyGuildState();
      const existing = listForChannel(current, channel.id);
      const items =
        existing?.list.items ?? legacyItemsForChannel(current, channel.id);
      const draftList: ChannelTodoState = {
        ...existing?.list,
        channelId: channel.id,
        targetKind: channel.isThread() ? "thread" : "channel",
        items,
      };
      const sent = await channel.send(todoMessageCreateOptions(draftList));
      const list: ChannelTodoState = {
        ...draftList,
        channelId: sent.channelId,
        messageId: sent.id,
      };
      await sent.edit(todoMessageEditOptions(list));

      let pinned = true;
      let pinError: string | undefined;
      try {
        await sent.pin("Created by /sandi todo");
      } catch (error) {
        pinned = false;
        pinError = error instanceof Error ? error.message : String(error);
        log.warn("failed to pin todo list message", {
          channelId: sent.channelId,
          messageId: sent.id,
          error: pinError,
        });
      }

      return {
        result: buildCreateTodoListResult(sent.url, pinned, pinError),
        next: {
          guilds: {
            ...state.guilds,
            [guildId]: updateGuildList(current, {
              kind: "channel",
              channelId: sent.channelId,
              list,
            }),
          },
        },
      };
    });
  }

  async handleInteraction(interaction: Interaction): Promise<boolean> {
    try {
      if (interaction.isButton()) {
        const parsed = parseTodoCustomId(interaction.customId);
        if (!parsed) return false;
        if (parsed.action === "add") {
          await this.#showAddModal(interaction, parsed.messageId);
          return true;
        }
        if (parsed.action === "complete") {
          await this.#showCompleteSelect(interaction, parsed.messageId);
          return true;
        }
        if (parsed.action === "complete-item" && parsed.itemId) {
          await this.#completeButtonItem(
            interaction,
            parsed.messageId,
            parsed.itemId,
          );
          return true;
        }
        if (parsed.action === "refresh") {
          await this.#refresh(interaction, parsed.messageId);
          return true;
        }
      }

      if (interaction.isStringSelectMenu()) {
        const parsed = parseTodoCustomId(interaction.customId);
        if (!parsed) return false;
        if (parsed.action === "select") {
          await this.#completeSelected(interaction, parsed.messageId);
          return true;
        }
        if (parsed.action === "reminder" && parsed.itemId) {
          await this.#setReminderPreset(
            interaction,
            parsed.messageId,
            parsed.itemId,
          );
          return true;
        }
        if (parsed.action === "repeat" && parsed.itemId) {
          await this.#setRepeatPreset(
            interaction,
            parsed.messageId,
            parsed.itemId,
          );
          return true;
        }
      }

      if (interaction.isModalSubmit()) {
        const parsed = parseTodoCustomId(interaction.customId);
        if (!parsed) return false;
        if (parsed.action === "modal") {
          await this.#addFromModal(interaction, parsed.messageId);
          return true;
        }
        if (parsed.action === "reminder-custom" && parsed.itemId) {
          await this.#setCustomReminder(
            interaction,
            parsed.messageId,
            parsed.itemId,
          );
          return true;
        }
        if (parsed.action === "repeat-custom" && parsed.itemId) {
          await this.#setCustomRepeat(
            interaction,
            parsed.messageId,
            parsed.itemId,
          );
          return true;
        }
      }
    } catch (error) {
      log.warn("failed to handle todo interaction", {
        error: error instanceof Error ? error.message : String(error),
      });
      await respondToInteractionFailure(interaction);
      return true;
    }

    return false;
  }

  /**
   * Runs a read, mutate, and write of the todo state inside one cross-process
   * lock so concurrent same-identity processes cannot lose updates. The apply
   * callback receives the freshest on-disk state and returns an out-of-band
   * result plus, when there is something to persist, the next state. Returning
   * no `next` skips the write (the no-op or stale-list paths). Any Discord I/O
   * the callback performs (rendering, reminder writes) runs while the lock is
   * held; the managed-write heartbeat keeps the lock alive for the duration.
   */
  async #updateState<T>(
    apply: (
      state: TodoListState,
    ) => Promise<{ result: T; next?: TodoListState }>,
  ): Promise<T> {
    const box: { value?: { result: T } } = {};
    await this.#store.updateManaged(async (state) => {
      const applied = await apply(state);
      box.value = { result: applied.result };
      return applied.next ?? state;
    }, EMPTY_STATE);
    if (!box.value) throw new Error("todo update produced no result");
    return box.value.result;
  }

  async #capture(message: Message, itemText: string): Promise<void> {
    const guildId = message.guildId;
    if (!guildId) return;

    try {
      await this.#updateState<void>(async (state) => {
        const current = state.guilds[guildId] ?? emptyGuildState();
        const destination = await this.#destinationForMessage(message, current);
        if (!destination) return { result: undefined };

        if (destination.list.items.length >= MAX_TODO_ITEMS) {
          log.info("todo list is full; skipping captured item", {
            messageId: message.id,
            guildId,
            channelId: destination.list.channelId,
          });
          await this.#renderList(destination.list);
          return { result: undefined };
        }

        const item: TodoItem = {
          id: message.id,
          text: itemText,
          authorName: message.member?.displayName ?? message.author.username,
          sourceUrl: message.url,
          createdAt: message.createdAt.toISOString(),
        };
        const updatedList = await this.#upsertRenderedList(
          {
            ...destination.list,
            items: [...destination.list.items, item],
          },
          destination.channel,
        );
        return {
          result: undefined,
          next: {
            guilds: {
              ...state.guilds,
              [guildId]: updateGuildList(current, {
                ...destination,
                list: updatedList,
              }),
            },
          },
        };
      });
    } catch (error) {
      log.error("failed to capture todo item", {
        messageId: message.id,
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #showAddModal(
    interaction: ButtonInteraction,
    messageId: string,
  ): Promise<void> {
    const ref = await this.#readListByMessageId(interaction.guildId, messageId);
    if (!ref) {
      await interaction.reply(staleListResponse());
      return;
    }

    if (ref.list.items.length >= MAX_TODO_ITEMS) {
      await this.#renderList(ref.list);
      await interaction.reply(fullListResponse());
      return;
    }

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(todoCustomId("modal", messageId))
        .setTitle("Add a to-do item")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(TODO_TEXT_INPUT_ID)
              .setLabel("What should go on the list?")
              .setStyle(TextInputStyle.Short)
              .setMaxLength(DISPLAY_ITEM_LIMIT)
              .setRequired(true),
          ),
        ),
    );
  }

  async #showCompleteSelect(
    interaction: ButtonInteraction,
    messageId: string,
  ): Promise<void> {
    const ref = await this.#readListByMessageId(interaction.guildId, messageId);
    if (!ref) {
      await interaction.reply(staleListResponse());
      return;
    }

    if (ref.list.items.length === 0) {
      await interaction.reply({
        content: "Nothing to complete yet.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.reply({
      content: "Which item is done?",
      components: [completeSelectRow(messageId, ref.list.items)],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  async #refresh(
    interaction: ButtonInteraction,
    messageId: string,
  ): Promise<void> {
    const ref = await this.#readListByMessageId(interaction.guildId, messageId);
    if (ref) await this.#renderList(ref.list);
    const refreshed = ref !== undefined;

    if (!refreshed) {
      await interaction.reply(staleListResponse());
      return;
    }

    await interaction.reply({
      content: "Refreshed the list.",
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  async #addFromModal(
    interaction: ModalSubmitInteraction,
    messageId: string,
  ): Promise<void> {
    const rawText = interaction.fields.getTextInputValue(TODO_TEXT_INPUT_ID);
    const text = cleanItemText(rawText);
    if (!text) {
      await interaction.reply({
        content: "That item was too tiny for the list gremlin to hold.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const result = await this.#updateState<AddFromModalResult>(
      async (state) => {
        const guildId = interaction.guildId;
        if (!guildId) return { result: { kind: "stale" } };
        const current = state.guilds[guildId] ?? emptyGuildState();
        const ref = findListByMessageId(current, messageId);
        if (!ref) return { result: { kind: "stale" } };
        if (ref.list.items.length >= MAX_TODO_ITEMS) {
          await this.#renderList(ref.list);
          return { result: { kind: "full" } };
        }

        const item = buildTodoItem({
          id: randomUUID(),
          text,
          authorName: displayNameFromInteraction(interaction),
          createdAt: new Date().toISOString(),
        });
        const updatedList = await this.#upsertRenderedList({
          ...ref.list,
          items: [...ref.list.items, item],
        });
        return {
          result: { kind: "added", item },
          next: {
            guilds: {
              ...state.guilds,
              [guildId]: updateGuildList(current, {
                ...ref,
                list: updatedList,
              }),
            },
          },
        };
      },
    );

    if (result.kind === "stale") {
      await interaction.reply(staleListResponse());
      return;
    }
    if (result.kind === "full") {
      await interaction.reply(fullListResponse());
      return;
    }

    await interaction.reply({
      content: todoSetupContent(result.item),
      components: todoSetupComponents(messageId, result.item),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  async #setReminderPreset(
    interaction: StringSelectMenuInteraction,
    messageId: string,
    itemId: string,
  ): Promise<void> {
    const selected = interaction.values[0];
    if (!selected) {
      await interaction.update({
        content: "No reminder option was selected.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (selected === "custom") {
      await interaction.showModal(customReminderModal(messageId, itemId));
      return;
    }

    const reminderAt = reminderPresetToIso(selected);
    if (selected !== "none" && !reminderAt) {
      await interaction.update({
        content: "That reminder option was not valid anymore.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const updated = await this.#updateTodoReminder({
      guildId: interaction.guildId,
      messageId,
      itemId,
      userId: interaction.user.id,
      createdBy: userFromInteraction(interaction),
      reminderAt,
      recurrence: undefined,
      recurrenceSummary: undefined,
    });

    if (!updated) {
      await interaction.update(staleSetupResponse());
      return;
    }

    await interaction.update({
      content: todoSetupContent(updated),
      components: todoSetupComponents(messageId, updated),
      allowedMentions: { parse: [] },
    });
  }

  async #setCustomReminder(
    interaction: ModalSubmitInteraction,
    messageId: string,
    itemId: string,
  ): Promise<void> {
    const parsed = parseReminderDateInput(
      interaction.fields.getTextInputValue(TODO_CUSTOM_REMINDER_INPUT_ID),
    );
    if (parsed.kind !== "valid") {
      await interaction.reply({
        content:
          parsed.kind === "invalid"
            ? parsed.message
            : "Enter a reminder date/time, like `2026-05-26 9am`.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const updated = await this.#updateTodoReminder({
      guildId: interaction.guildId,
      messageId,
      itemId,
      userId: interaction.user.id,
      createdBy: userFromInteraction(interaction),
      reminderAt: parsed.iso,
      recurrence: undefined,
      recurrenceSummary: undefined,
    });

    if (!updated) {
      await interaction.reply(staleSetupResponse());
      return;
    }

    await interaction.reply({
      content: todoSetupContent(updated),
      components: todoSetupComponents(messageId, updated),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  async #setRepeatPreset(
    interaction: StringSelectMenuInteraction,
    messageId: string,
    itemId: string,
  ): Promise<void> {
    const selected = interaction.values[0];
    if (!selected) {
      await interaction.update({
        content: "No repeat option was selected.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (selected === "custom") {
      await interaction.showModal(customRepeatModal(messageId, itemId));
      return;
    }

    const current = await this.#readTodoItem(
      interaction.guildId,
      messageId,
      itemId,
    );
    if (!current) {
      await interaction.update(staleSetupResponse());
      return;
    }
    const repeat =
      selected === "none"
        ? undefined
        : repeatPresetToRecurrence(selected, current.item.reminderAt);
    if (selected !== "none" && !repeat) {
      await interaction.update({
        content: "Set a reminder time before choosing that repeat option.",
        components: todoSetupComponents(messageId, current.item),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const updated = await this.#updateTodoReminder({
      guildId: interaction.guildId,
      messageId,
      itemId,
      userId: interaction.user.id,
      createdBy: userFromInteraction(interaction),
      reminderAt: current.item.reminderAt,
      recurrence: repeat?.recurrence,
      recurrenceSummary: repeat?.summary,
    });

    if (!updated) {
      await interaction.update(staleSetupResponse());
      return;
    }

    await interaction.update({
      content: todoSetupContent(updated),
      components: todoSetupComponents(messageId, updated),
      allowedMentions: { parse: [] },
    });
  }

  async #setCustomRepeat(
    interaction: ModalSubmitInteraction,
    messageId: string,
    itemId: string,
  ): Promise<void> {
    const current = await this.#readTodoItem(
      interaction.guildId,
      messageId,
      itemId,
    );
    if (!current) {
      await interaction.reply(staleSetupResponse());
      return;
    }
    const parsed = parseReminderRepeatInput(
      interaction.fields.getTextInputValue(TODO_CUSTOM_REPEAT_INPUT_ID),
      current.item.reminderAt,
    );
    if (parsed.kind !== "valid") {
      await interaction.reply({
        content:
          parsed.kind === "invalid"
            ? parsed.message
            : "Enter a repeat, like `weekly Mon 6pm`.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const updated = await this.#updateTodoReminder({
      guildId: interaction.guildId,
      messageId,
      itemId,
      userId: interaction.user.id,
      createdBy: userFromInteraction(interaction),
      reminderAt:
        current.item.reminderAt ??
        nextReminderAt(parsed.recurrence).toISOString(),
      recurrence: parsed.recurrence,
      recurrenceSummary: parsed.summary,
    });

    if (!updated) {
      await interaction.reply(staleSetupResponse());
      return;
    }

    await interaction.reply({
      content: todoSetupContent(updated),
      components: todoSetupComponents(messageId, updated),
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  async #completeButtonItem(
    interaction: ButtonInteraction,
    messageId: string,
    itemId: string,
  ): Promise<void> {
    const completed = await this.#updateState<
      { item: TodoItem; list: ChannelTodoState } | undefined
    >(async (state) => {
      const guildId = interaction.guildId;
      if (!guildId) return { result: undefined };
      const current = state.guilds[guildId] ?? emptyGuildState();
      const ref = findListByMessageId(current, messageId);
      if (!ref) return { result: undefined };

      const item = ref.list.items.find((candidate) => candidate.id === itemId);
      if (!item) return { result: undefined };

      const updatedList: ChannelTodoState = {
        ...ref.list,
        items: ref.list.items.filter((candidate) => candidate.id !== itemId),
      };
      await this.#markLinkedReminderDone(item, interaction);
      return {
        result: { item, list: updatedList },
        next: {
          guilds: {
            ...state.guilds,
            [guildId]: updateGuildList(current, {
              ...ref,
              list: updatedList,
            }),
          },
        },
      };
    });

    if (!completed) {
      await interaction.reply({
        content:
          "That item was already completed or this list is no longer current.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.update(todoMessageEditOptions(completed.list));
  }

  async #completeSelected(
    interaction: StringSelectMenuInteraction,
    messageId: string,
  ): Promise<void> {
    const selectedId = interaction.values[0];
    if (!selectedId) {
      await interaction.update({
        content: "No item was selected.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferUpdate();
    const completed = await this.#updateState<TodoItem | undefined>(
      async (state) => {
        const guildId = interaction.guildId;
        if (!guildId) return { result: undefined };
        const current = state.guilds[guildId] ?? emptyGuildState();
        const ref = findListByMessageId(current, messageId);
        if (!ref) return { result: undefined };

        const item = ref.list.items.find(
          (candidate) => candidate.id === selectedId,
        );
        if (!item) return { result: undefined };

        const updatedList = await this.#upsertRenderedList({
          ...ref.list,
          items: ref.list.items.filter(
            (candidate) => candidate.id !== selectedId,
          ),
        });
        await this.#markLinkedReminderDone(item, interaction);
        return {
          result: item,
          next: {
            guilds: {
              ...state.guilds,
              [guildId]: updateGuildList(current, {
                ...ref,
                list: updatedList,
              }),
            },
          },
        };
      },
    );

    if (!completed) {
      await interaction.editReply({
        content:
          "That item was already completed or this list is no longer current.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await deleteEphemeralReply(interaction);
  }

  async #readListByMessageId(
    guildId: string | null,
    messageId: string,
  ): Promise<TodoListRef | undefined> {
    if (!guildId) return undefined;
    const state = await this.#store.read(EMPTY_STATE);
    const current = state.guilds[guildId] ?? emptyGuildState();
    return findListByMessageId(current, messageId);
  }

  async #readTodoItem(
    guildId: string | null,
    messageId: string,
    itemId: string,
  ): Promise<{ ref: TodoListRef; item: TodoItem } | undefined> {
    const ref = await this.#readListByMessageId(guildId, messageId);
    const item = ref?.list.items.find((candidate) => candidate.id === itemId);
    if (!ref || !item) return undefined;
    return { ref, item };
  }

  async #updateTodoReminder(input: {
    guildId: string | null;
    messageId: string;
    itemId: string;
    userId: string;
    createdBy: ReminderUser;
    reminderAt: string | undefined;
    recurrence: ReminderRecurrence | undefined;
    recurrenceSummary: string | undefined;
  }): Promise<TodoItem | undefined> {
    const guildId = input.guildId;
    if (!guildId) return undefined;
    // Read, mutate the item, render, and write all under one cross-process lock
    // so a concurrent reminder update or completion in another process cannot
    // lose this change. The reminder file writes run inside the same section.
    return this.#updateState<TodoItem | undefined>(async (state) => {
      const current = state.guilds[guildId] ?? emptyGuildState();
      const ref = findListByMessageId(current, input.messageId);
      const item = ref?.list.items.find(
        (candidate) => candidate.id === input.itemId,
      );
      if (!ref || !item) return { result: undefined };

      let updatedItem: TodoItem;
      if (!input.reminderAt) {
        if (item.reminderId) {
          await deleteReminder(this.#remindersRoot, item.reminderId);
        }
        updatedItem = withoutReminder(item);
      } else {
        const reminderId = item.reminderId ?? generatedTodoReminderId();
        const reminder: Reminder = {
          target: reminderTargetForList(ref.list),
          text: `Todo: ${item.text}`,
          createdAt: new Date().toISOString(),
          createdBy: input.createdBy,
          audienceUserIds: [input.userId],
          status: "active",
          nextFireAt: input.reminderAt,
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
          followupIntervalMinutes: DEFAULT_FOLLOWUP_INTERVAL_MINUTES,
          fireCount: 0,
          messageRefs: [],
        };
        await writeReminder(this.#remindersRoot, reminderId, reminder);
        updatedItem = withReminder(item, {
          reminderId,
          reminderAt: input.reminderAt,
          recurrenceSummary: input.recurrenceSummary,
        });
      }

      const updatedList = await this.#upsertRenderedList({
        ...ref.list,
        items: ref.list.items.map((candidate) =>
          candidate.id === updatedItem.id ? updatedItem : candidate,
        ),
      });
      return {
        result: updatedItem,
        next: {
          guilds: {
            ...state.guilds,
            [guildId]: updateGuildList(current, { ...ref, list: updatedList }),
          },
        },
      };
    });
  }

  async #destinationForMessage(
    message: Message,
    current: GuildTodoState,
  ): Promise<TodoDestination | undefined> {
    const localList = await this.#listForMessageChannel(message, current);
    if (localList) return localList;

    const channel = await this.#resolveTodoChannel(message.guildId, current);
    if (!channel) return undefined;
    return {
      kind: "legacy",
      list: {
        channelId: channel.id,
        messageId: current.messageId,
        items: current.items,
      },
      channel,
    };
  }

  async #listForMessageChannel(
    message: Message,
    current: GuildTodoState,
  ): Promise<TodoListRef | undefined> {
    const directList = listForChannel(current, message.channelId);
    if (directList) return directList;

    const thread = message.channel.isThread() ? message.channel : undefined;
    if (thread?.parentId) {
      const parentList = listForChannel(current, thread.parentId);
      if (parentList) return parentList;
    }

    if (current.channelId === message.channelId) {
      return { kind: "legacy", list: legacyList(current) };
    }
    if (thread?.parentId && current.channelId === thread.parentId) {
      return { kind: "legacy", list: legacyList(current) };
    }

    return undefined;
  }

  async #resolveTodoChannel(
    guildId: string | null,
    current: GuildTodoState,
  ): Promise<SendableChannels | undefined> {
    if (!guildId) return undefined;
    if (current.channelId) {
      const channel = await this.#client.channels.fetch(current.channelId);
      if (channel?.isSendable()) return channel;
    }

    const guild = await this.#client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (channel?.name === TODO_CHANNEL_NAME && channel.isSendable()) {
        return channel;
      }
    }

    log.error("todo-list channel was not found", { guildId: guildId });
    return undefined;
  }

  async #upsertRenderedList(
    list: ChannelTodoState,
    fallbackChannel?: SendableChannels,
  ): Promise<ChannelTodoState> {
    const channel = fallbackChannel ?? (await this.#fetchSendableChannel(list));
    if (!channel) return list;

    if (list.messageId && "messages" in channel) {
      try {
        const existing = await channel.messages.fetch(list.messageId);
        const edited = await existing.edit(todoMessageEditOptions(list));
        return { ...list, messageId: edited.id };
      } catch (error) {
        log.error("failed to edit todo list message; creating a new one", {
          channelId: channel.id,
          messageId: list.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sent = await channel.send(todoMessageCreateOptions(list));
    await sent.edit(todoMessageEditOptions({ ...list, messageId: sent.id }));
    return { ...list, channelId: sent.channelId, messageId: sent.id };
  }

  async #renderList(list: ChannelTodoState): Promise<void> {
    if (!list.messageId) return;
    const channel = await this.#fetchSendableChannel(list);
    if (!channel || !("messages" in channel)) return;
    const message = await channel.messages.fetch(list.messageId);
    await message.edit(todoMessageEditOptions(list));
  }

  async #fetchSendableChannel(
    list: ChannelTodoState,
  ): Promise<SendableChannels | undefined> {
    const channel = await this.#client.channels.fetch(list.channelId);
    return channel?.isSendable() ? channel : undefined;
  }

  async #markLinkedReminderDone(
    item: TodoItem,
    interaction: Interaction,
  ): Promise<void> {
    if (!item.reminderId) return;
    try {
      const reminder = await readReminder(this.#remindersRoot, item.reminderId);
      if (reminder.status !== "active") return;
      await writeReminder(
        this.#remindersRoot,
        item.reminderId,
        completedReminder(reminder, userFromInteraction(interaction)),
      );
    } catch (error) {
      log.warn("failed to mark linked todo reminder done", {
        reminderId: item.reminderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function extractTodoItem(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;
    const item =
      extractTodoLine(line) ??
      extractReminderLine(line) ??
      extractListLine(line);
    if (item) return cleanItemText(item);
  }
  return undefined;
}

function extractTodoLine(line: string): string | undefined {
  const todo = line.match(/^todo\s*(?::|[-–—])\s+(.+)$/iu);
  if (todo?.[1]) return todo[1];

  return undefined;
}

function extractReminderLine(line: string): string | undefined {
  const remindMe = line.match(/\bremind\s+me\s+(?:to\s+)?(.+)$/iu);
  if (remindMe?.[1]) return remindMe[1];

  const rememberTo = line.match(
    /\b(?:i\s+need\s+to\s+)?remember\s+to\s+(.+)$/iu,
  );
  if (rememberTo?.[1]) return rememberTo[1];

  return undefined;
}

function extractListLine(line: string): string | undefined {
  const addToMyList = line.match(
    /\badd\s+to\s+my\s+list\s*(?::|[-–—])\s+(.+)$/iu,
  );
  if (addToMyList?.[1]) return addToMyList[1];

  const addItemToMyList = line.match(/\badd\s+(.+?)\s+to\s+my\s+list\b/iu);
  if (addItemToMyList?.[1]) return addItemToMyList[1];

  return undefined;
}

function cleanItemText(value: string): string | undefined {
  const cleaned = normalizeWhitespace(value)
    .replace(/^["“”'‘’]+/u, "")
    .replace(/["“”'‘’]+$/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (cleaned.length < 2) return undefined;
  return sentenceCase(cleaned);
}

function sentenceCase(value: string): string {
  const [first = "", ...rest] = value;
  return `${first.toLocaleUpperCase()}${rest.join("")}`;
}

function todoMessageCreateOptions(
  list: ChannelTodoState,
): MessageCreateOptions {
  return {
    content: formatTodoList(list),
    allowedMentions: { parse: [] },
  };
}

function todoMessageEditOptions(list: ChannelTodoState): MessageEditOptions {
  return {
    content: formatTodoList(list),
    components: todoMessageComponents(list),
    allowedMentions: { parse: [] },
  };
}

function todoMessageComponents(
  list: ChannelTodoState,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (!list.messageId) return [];
  if (list.completionMode === "buttons") {
    return itemDoneButtonRows(list.messageId, list.items);
  }
  return [todoButtonRow(list.messageId, list.items)];
}

function formatTodoList(list: ChannelTodoState): string {
  if (list.displayMode === "grouped-reminders") {
    return formatGroupedReminderList(list);
  }

  const title = list.title ?? "To-do list";
  const instructions =
    list.instructions ??
    "In `todo-` / `tasks-` channels, type what to add or change; Sandi updates this list and removes handled messages. Elsewhere, use **Add item** below or explicit `todo: ...` capture.";
  const lines = [`# ${title}`, "", instructions, ""];

  if (list.items.length === 0) {
    lines.push(list.emptyText ?? "_Nothing here yet._");
    return lines.join("\n");
  }

  const visibleItems = [];
  let hiddenCount = 0;
  for (const item of list.items.toReversed()) {
    const line = formatTodoLine(item);
    const visibleLines = visibleItems.toReversed().map(formatTodoLine);
    const next = [...lines, ...visibleLines, line];
    if (next.join("\n").length > DISCORD_MESSAGE_LIMIT - 80) {
      hiddenCount += 1;
      continue;
    }
    visibleItems.push(item);
  }

  if (hiddenCount > 0) {
    lines.push(
      `_Plus ${hiddenCount} older item${hiddenCount === 1 ? "" : "s"} hidden to keep this in one Discord message._`,
      "",
    );
  }
  lines.push(...visibleItems.toReversed().map(formatTodoLine));

  return lines.join("\n");
}

function formatGroupedReminderList(list: ChannelTodoState): string {
  const title = list.title ?? "To-do list";
  const instructions = list.instructions;
  const lines = instructions
    ? [`# ${title}`, "", instructions, ""]
    : [`# ${title}`, ""];

  if (list.items.length === 0) {
    lines.push(list.emptyText ?? "_Nothing here yet._");
    return lines.join("\n");
  }

  const repeatItems = list.items.filter((item) => item.reminderRepeat);
  const oneTimeItems = list.items.filter((item) => !item.reminderRepeat);
  lines.push("**Repeat**");
  if (repeatItems.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(...repeatItems.map(formatGroupedRepeatLine));
  }
  lines.push("", "**One time**");
  if (oneTimeItems.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(...oneTimeItems.map(formatGroupedOneTimeLine));
  }

  return lines.join("\n");
}

function formatGroupedRepeatLine(item: TodoItem): string {
  const schedule = reminderDateAndTime(item.reminderAt);
  return `- ${limitDisplayText(item.text)}${schedule ? ` - ${schedule}` : ""}`;
}

function formatGroupedOneTimeLine(item: TodoItem): string {
  const schedule = reminderDateAndTime(item.reminderAt);
  const reason = item.reason ? ` - ${item.reason}` : "";
  return `- ${limitDisplayText(item.text)}${schedule ? ` - ${schedule}` : ""}${reason}`;
}

function reminderDateAndTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return undefined;
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${day} - ${time}`;
}

function formatTodoLine(item: TodoItem): string {
  const source = item.sourceUrl ? ` ([source](${item.sourceUrl}))` : "";
  const reminder = item.reminderAt
    ? ` — reminds ${formatDiscordTimestamp(item.reminderAt)}`
    : "";
  const repeat = item.reminderRepeat ? ` — repeats ${item.reminderRepeat}` : "";
  return `- ${limitDisplayText(item.text)} — ${item.authorName}${reminder}${repeat}${source}`;
}

function todoButtonRow(
  messageId: string,
  items: readonly TodoItem[],
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(todoCustomId("add", messageId))
      .setLabel(items.length >= MAX_TODO_ITEMS ? "List full" : "Add item")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(items.length >= MAX_TODO_ITEMS),
    new ButtonBuilder()
      .setCustomId(todoCustomId("complete", messageId))
      .setLabel("Complete item")
      .setStyle(ButtonStyle.Success)
      .setDisabled(items.length === 0),
    new ButtonBuilder()
      .setCustomId(todoCustomId("refresh", messageId))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );
}

function itemDoneButtonRows(
  messageId: string,
  items: readonly TodoItem[],
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (const item of items.slice(0, 25)) {
    const row = rows.at(-1);
    const targetRow =
      row && row.components.length < 5
        ? row
        : new ActionRowBuilder<MessageActionRowComponentBuilder>();
    if (targetRow !== row) rows.push(targetRow);
    targetRow.addComponents(
      new ButtonBuilder()
        .setCustomId(todoCustomId("complete-item", messageId, item.id))
        .setLabel(limitOptionText(`Done: ${item.text}`, 80))
        .setStyle(ButtonStyle.Success),
    );
  }
  return rows;
}

function completeSelectRow(
  messageId: string,
  items: readonly TodoItem[],
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const options = items
    .slice(-MAX_COMPLETION_OPTIONS)
    .toReversed()
    .map((item) => ({
      label: limitOptionText(item.text, 100),
      value: item.id,
      description: limitOptionText(`Added by ${item.authorName}`, 100),
    }));

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(todoCustomId("select", messageId))
      .setPlaceholder("Choose the completed item")
      .addOptions(...options),
  );
}

function todoSetupComponents(
  messageId: string,
  item: TodoItem,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [reminderPresetRow(messageId, item), repeatPresetRow(messageId, item)];
}

function reminderPresetRow(
  messageId: string,
  item: TodoItem,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(todoCustomId("reminder", messageId, item.id))
      .setPlaceholder("Reminder")
      .addOptions(
        { label: "No reminder", value: "none" },
        { label: "In 10 minutes", value: "10m" },
        { label: "In 1 hour", value: "1h" },
        { label: "Tomorrow at 9:00 AM", value: "tomorrow9" },
        { label: "Next weekday at 9:00 AM", value: "nextweekday9" },
        { label: "Custom date/time…", value: "custom" },
      ),
  );
}

function repeatPresetRow(
  messageId: string,
  item: TodoItem,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(todoCustomId("repeat", messageId, item.id))
      .setPlaceholder("Repeat")
      .setDisabled(!item.reminderAt)
      .addOptions(
        { label: "Does not repeat", value: "none" },
        { label: "Daily at reminder time", value: "daily" },
        { label: "Weekdays at reminder time", value: "weekdays" },
        { label: "Weekly on that weekday/time", value: "weekly" },
        { label: "Monthly on that day/time", value: "monthly" },
        { label: "2nd and 4th Wednesday", value: "second-fourth-wed" },
        { label: "Custom repeat…", value: "custom" },
      ),
  );
}

function customReminderModal(messageId: string, itemId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(todoCustomId("reminder-custom", messageId, itemId))
    .setTitle("Set a reminder")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TODO_CUSTOM_REMINDER_INPUT_ID)
          .setLabel("Reminder date/time, Pacific time")
          .setPlaceholder(
            "Accepted: YYYY-MM-DD 9am PT, ISO timestamp, or <t:...>",
          )
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
}

function customRepeatModal(messageId: string, itemId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(todoCustomId("repeat-custom", messageId, itemId))
    .setTitle("Set a repeat")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TODO_CUSTOM_REPEAT_INPUT_ID)
          .setLabel("Repeat, Pacific time")
          .setPlaceholder(
            "Keywords: daily, weekdays, weekly Mon, monthly 1st, 2nd/4th Wed + time",
          )
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
}

function todoCustomId(
  action: TodoAction,
  messageId: string,
  itemId?: string,
): string {
  const code = todoActionCode(action);
  return ["t", code, messageId, itemId].filter(isPresentString).join(":");
}

function parseTodoCustomId(customId: string): TodoCustomId | undefined {
  const parts = customId.split(":");
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== "t") {
    return undefined;
  }
  const action = todoAction(parts[1]);
  const messageId = parts[2];
  const itemId = parts[3];
  if (!action || !messageId) return undefined;
  if (itemId) return { action, messageId, itemId };
  return { action, messageId };
}

function todoActionCode(action: TodoAction): string {
  switch (action) {
    case "add":
      return "add";
    case "complete":
      return "done";
    case "select":
      return "sel";
    case "refresh":
      return "ref";
    case "modal":
      return "new";
    case "complete-item":
      return "itemdone";
    case "reminder":
      return "rem";
    case "repeat":
      return "rep";
    case "reminder-custom":
      return "remc";
    case "repeat-custom":
      return "repc";
  }
}

function todoAction(value: string | undefined): TodoAction | undefined {
  switch (value) {
    case "add":
      return "add";
    case "done":
      return "complete";
    case "sel":
      return "select";
    case "ref":
      return "refresh";
    case "new":
      return "modal";
    case "itemdone":
      return "complete-item";
    case "rem":
      return "reminder";
    case "rep":
      return "repeat";
    case "remc":
      return "reminder-custom";
    case "repc":
      return "repeat-custom";
    default:
      return undefined;
  }
}

function emptyGuildState(): GuildTodoState {
  return { items: [] };
}

function listForChannel(
  guildState: GuildTodoState,
  channelId: string,
): TodoListRef | undefined {
  const channelList = guildState.lists?.[channelId];
  if (channelList) {
    return { kind: "channel", channelId, list: channelList };
  }
  if (guildState.channelId === channelId) {
    return { kind: "legacy", list: legacyList(guildState) };
  }
  return undefined;
}

function legacyItemsForChannel(
  guildState: GuildTodoState,
  channelId: string,
): TodoItem[] {
  return guildState.channelId === channelId ? guildState.items : [];
}

function findListByMessageId(
  guildState: GuildTodoState,
  messageId: string,
): TodoListRef | undefined {
  const lists = guildState.lists ?? {};
  for (const list of Object.values(lists)) {
    if (list.messageId === messageId) {
      return { kind: "channel", channelId: list.channelId, list };
    }
  }

  if (guildState.messageId === messageId) {
    return { kind: "legacy", list: legacyList(guildState) };
  }

  return undefined;
}

function legacyList(guildState: GuildTodoState): ChannelTodoState {
  return {
    channelId: guildState.channelId ?? "",
    messageId: guildState.messageId,
    items: guildState.items,
  };
}

function updateGuildList(
  guildState: GuildTodoState,
  ref: TodoListRef,
): GuildTodoState {
  if (ref.kind === "legacy") {
    return {
      ...guildState,
      channelId: ref.list.channelId,
      messageId: ref.list.messageId,
      items: ref.list.items,
    };
  }

  return {
    ...guildState,
    lists: {
      ...(guildState.lists ?? {}),
      [ref.channelId]: ref.list,
    },
  };
}

function buildTodoItem(input: {
  id: string;
  text: string;
  authorName: string;
  createdAt: string;
  reminderPlan?: ReminderPlan;
}): TodoItem {
  const base = {
    id: input.id,
    text: input.text,
    authorName: input.authorName,
    createdAt: input.createdAt,
  };
  if (!input.reminderPlan) return base;
  return {
    ...base,
    reminderAt: input.reminderPlan.at,
    ...(input.reminderPlan.recurrenceSummary
      ? { reminderRepeat: input.reminderPlan.recurrenceSummary }
      : {}),
    reminderId: input.reminderPlan.id,
  };
}

function isOneTimeLinkedReminder(item: TodoItem, reminderId: string): boolean {
  return item.reminderId === reminderId && !item.reminderRepeat;
}

function reminderTargetForList(list: ChannelTodoState): ReminderTarget {
  if (list.targetKind === "thread") {
    return { kind: "thread", threadId: list.channelId };
  }
  return { kind: "channel", channelId: list.channelId };
}

function staleListResponse(): {
  content: string;
  ephemeral: true;
  allowedMentions: { parse: [] };
} {
  return {
    content:
      "That todo list message is no longer the current one. Run `/sandi todo` to make a fresh pinned list here.",
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

function fullListResponse(): {
  content: string;
  ephemeral: true;
  allowedMentions: { parse: [] };
} {
  return {
    content:
      "This todo list is full at 10 items. Complete something before adding more.",
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

function staleSetupResponse(): {
  content: string;
  components: [];
  allowedMentions: { parse: [] };
} {
  return {
    content: "That todo item is no longer current.",
    components: [],
    allowedMentions: { parse: [] },
  };
}

function todoSetupContent(item: TodoItem): string {
  const lines = [`Added: ${item.text}`];
  if (item.reminderAt) {
    lines.push(`Reminder: ${formatDiscordTimestamp(item.reminderAt)}`);
  } else {
    lines.push("Reminder: none");
  }
  lines.push(`Repeat: ${item.reminderRepeat ?? "none"}`);
  return lines.join("\n");
}

async function deleteEphemeralReply(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  try {
    await interaction.deleteReply();
  } catch (error) {
    log.warn("failed to delete ephemeral todo response", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function respondToInteractionFailure(
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  const content =
    "I couldn't update that todo list. It may have changed or been removed.";
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}

function displayNameFromInteraction(interaction: Interaction): string {
  if (interaction.member && "displayName" in interaction.member) {
    return interaction.member.displayName;
  }
  return interaction.user.globalName ?? interaction.user.username;
}

function userFromInteraction(interaction: Interaction): ReminderUser {
  const username = displayNameFromInteraction(interaction);
  return { discordUserId: interaction.user.id, username };
}

function completedReminder(reminder: Reminder, doneBy: ReminderUser): Reminder {
  const completedAt = new Date();
  const nextRun = nextReminderRecurrenceRun(reminder, completedAt);
  if (nextRun) {
    return {
      ...reminder,
      status: "active",
      nextFireAt: nextRun.toISOString(),
      fireCount: 0,
      messageRefs: [],
      doneAt: completedAt.toISOString(),
      doneBy,
    };
  }
  return {
    ...reminder,
    status: "done",
    doneAt: completedAt.toISOString(),
    doneBy,
  };
}

function buildCreateTodoListResult(
  messageUrl: string,
  pinned: boolean,
  pinError: string | undefined,
): CreateTodoListResult {
  if (pinError) return { messageUrl, pinned, pinError };
  return { messageUrl, pinned };
}

function withReminder(
  item: TodoItem,
  input: {
    reminderId: string;
    reminderAt: string;
    recurrenceSummary: string | undefined;
  },
): TodoItem {
  return {
    id: item.id,
    text: item.text,
    authorName: item.authorName,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    createdAt: item.createdAt,
    reminderAt: input.reminderAt,
    ...(input.recurrenceSummary
      ? { reminderRepeat: input.recurrenceSummary }
      : {}),
    reminderId: input.reminderId,
  };
}

function withoutReminder(item: TodoItem): TodoItem {
  return {
    id: item.id,
    text: item.text,
    authorName: item.authorName,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    createdAt: item.createdAt,
  };
}

function reminderPresetToIso(value: string): string | undefined {
  const now = new Date();
  if (value === "10m")
    return new Date(now.getTime() + 10 * 60_000).toISOString();
  if (value === "1h")
    return new Date(now.getTime() + 60 * 60_000).toISOString();
  const parts = pacificParts(now);
  if (!parts.year || !parts.month || !parts.day) return undefined;
  const dateParts = { year: parts.year, month: parts.month, day: parts.day };
  if (value === "tomorrow9") {
    return pacificLocalDateTimeToIso(addPacificDays(dateParts, 1, 9, 0));
  }
  if (value === "nextweekday9") {
    return pacificLocalDateTimeToIso(nextPacificWeekday(dateParts, 9, 0));
  }
  return undefined;
}

function repeatPresetToRecurrence(
  value: string,
  reminderAt: string | undefined,
): { recurrence: ReminderRecurrence; summary: string } | undefined {
  const time = fallbackTime(reminderAt);
  if (!time) return undefined;
  const parts = reminderAt ? pacificParts(new Date(reminderAt)) : undefined;
  if (value === "daily") {
    return repeatFromSchedule(
      `${time.minute} ${time.hour} * * *`,
      `daily at ${formatRepeatTime(time)}`,
    );
  }
  if (value === "weekdays") {
    return repeatFromSchedule(
      `${time.minute} ${time.hour} * * MON-FRI`,
      `weekdays at ${formatRepeatTime(time)}`,
    );
  }
  if (value === "weekly") {
    const weekday = fallbackWeekday(reminderAt);
    if (!weekday) return undefined;
    return repeatFromSchedule(
      `${time.minute} ${time.hour} * * ${weekday.cron}`,
      `weekly on ${weekday.label} at ${formatRepeatTime(time)}`,
    );
  }
  if (value === "monthly") {
    const day = parts?.day;
    if (!day) return undefined;
    return repeatFromSchedule(
      `${time.minute} ${time.hour} ${day} * *`,
      `monthly on the ${formatOrdinal(day)} at ${formatRepeatTime(time)}`,
    );
  }
  if (value === "second-fourth-wed") {
    return repeatFromSchedule(
      `${time.minute} ${time.hour} * * WED#2,WED#4`,
      `2nd and 4th Wednesday at ${formatRepeatTime(time)}`,
    );
  }
  return undefined;
}

function repeatFromSchedule(
  schedule: string,
  summary: string,
): { recurrence: ReminderRecurrence; summary: string } {
  return {
    recurrence: { schedule, timezone: PACIFIC_TIME_ZONE },
    summary,
  };
}

function addPacificDays(
  parts: {
    year: number;
    month: number;
    day: number;
  },
  days: number,
  hour: number,
  minute: number,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const next = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour,
    minute,
  };
}

function nextPacificWeekday(
  parts: {
    year: number;
    month: number;
    day: number;
  },
  hour: number,
  minute: number,
): { year: number; month: number; day: number; hour: number; minute: number } {
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = addPacificDays(parts, offset, hour, minute);
    const dayOfWeek = new Date(
      Date.UTC(candidate.year, candidate.month - 1, candidate.day),
    ).getUTCDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) return candidate;
  }
  return addPacificDays(parts, 1, hour, minute);
}

function parseReminderDateInput(value: string): ReminderDateParseResult {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "none" };

  const discordTimestamp = parseDiscordTimestamp(trimmed);
  if (discordTimestamp) return futureReminderResult(discordTimestamp);

  const explicitDate = parseExplicitDate(trimmed);
  if (explicitDate) return futureReminderResult(explicitDate);

  const pacificDate = parsePacificDateTime(trimmed);
  if (pacificDate) return futureReminderResult(pacificDate);

  return {
    kind: "invalid",
    message:
      "I couldn't understand that reminder date. Try `2026-05-26 9am PT`, an ISO timestamp, or a Discord timestamp like `<t:1780000000>`.",
  };
}

function parseDiscordTimestamp(value: string): string | undefined {
  const match = value.match(/^<t:(\d{10,13})(?::[tTdDfFR])?>$/u);
  const raw = match?.[1];
  if (!raw) return undefined;
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch)) return undefined;
  const epochMs = raw.length === 13 ? epoch : epoch * 1_000;
  return new Date(epochMs).toISOString();
}

function parseExplicitDate(value: string): string | undefined {
  if (!/(?:z|[+-]\d{2}:?\d{2})$/iu.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function parsePacificDateTime(value: string): string | undefined {
  const normalized = value.replace(/\s+pt$/iu, "").trim();
  const match = normalized.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/iu,
  );
  if (!match) return undefined;

  const year = parseInteger(match[1]);
  const month = parseInteger(match[2]);
  const day = parseInteger(match[3]);
  const rawHour = parseInteger(match[4]);
  const minute = parseInteger(match[5]) ?? 0;
  const meridiem = match[6]?.toLocaleLowerCase();
  if (!year || !month || !day) return undefined;

  const hour = normalizeHour(rawHour, meridiem);
  if (hour === undefined) return undefined;
  if (minute < 0 || minute > 59) return undefined;

  return pacificLocalDateTimeToIso({ year, month, day, hour, minute });
}

function normalizeHour(
  rawHour: number | undefined,
  meridiem: string | undefined,
): number | undefined {
  if (rawHour === undefined) return DEFAULT_DATE_ONLY_REMINDER_HOUR;
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) return undefined;
    if (meridiem === "am") return rawHour === 12 ? 0 : rawHour;
    if (meridiem === "pm") return rawHour === 12 ? 12 : rawHour + 12;
    return undefined;
  }
  if (rawHour < 0 || rawHour > 23) return undefined;
  return rawHour;
}

function pacificLocalDateTimeToIso(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string | undefined {
  const localAsUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
  );
  let offset = timeZoneOffsetMs(PACIFIC_TIME_ZONE, new Date(localAsUtc));
  if (offset === undefined) return undefined;
  let utcMs = localAsUtc - offset;
  offset = timeZoneOffsetMs(PACIFIC_TIME_ZONE, new Date(utcMs));
  if (offset === undefined) return undefined;
  utcMs = localAsUtc - offset;
  const date = new Date(utcMs);
  if (!Number.isFinite(date.getTime())) return undefined;

  const parts = pacificParts(date);
  if (
    parts.year !== input.year ||
    parts.month !== input.month ||
    parts.day !== input.day ||
    parts.hour !== input.hour ||
    parts.minute !== input.minute
  ) {
    return undefined;
  }

  return date.toISOString();
}

function pacificParts(date: Date): {
  year: number | undefined;
  month: number | undefined;
  day: number | undefined;
  hour: number | undefined;
  minute: number | undefined;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const fields = new Map<string, string>();
  for (const part of formatter.formatToParts(date)) {
    fields.set(part.type, part.value);
  }
  return {
    year: parseInteger(fields.get("year")),
    month: parseInteger(fields.get("month")),
    day: parseInteger(fields.get("day")),
    hour: parseInteger(fields.get("hour")),
    minute: parseInteger(fields.get("minute")),
  };
}

function timeZoneOffsetMs(timeZone: string, date: Date): number | undefined {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const part = formatter
    .formatToParts(date)
    .find((candidate) => candidate.type === "timeZoneName");
  const value = part?.value;
  if (!value || value === "GMT") return 0;
  const match = value.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u);
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = parseInteger(match[2]);
  const minutes = parseInteger(match[3]) ?? 0;
  if (hours === undefined) return undefined;
  return sign * (hours * 60 + minutes) * 60_000;
}

function parseRepeatTime(value: string): RepeatTime | undefined {
  const meridiemMatch = value.match(
    /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/u,
  );
  if (meridiemMatch) {
    return buildRepeatTime(
      parseInteger(meridiemMatch[1]),
      parseInteger(meridiemMatch[2]) ?? 0,
      meridiemMatch[3],
    );
  }

  const atMatch = value.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/u);
  if (!atMatch) return undefined;
  return buildRepeatTime(
    parseInteger(atMatch[1]),
    parseInteger(atMatch[2]) ?? 0,
    undefined,
  );
}

function buildRepeatTime(
  rawHour: number | undefined,
  minute: number,
  meridiem: string | undefined,
): RepeatTime | undefined {
  const hour = normalizeHour(rawHour, meridiem);
  if (hour === undefined || minute < 0 || minute > 59) return undefined;
  return { hour, minute };
}

function fallbackTime(reminderAt: string | undefined): RepeatTime | undefined {
  if (!reminderAt) return undefined;
  const parts = pacificParts(new Date(reminderAt));
  if (parts.hour === undefined || parts.minute === undefined) return undefined;
  return { hour: parts.hour, minute: parts.minute };
}

function parseWeekday(value: string): ParsedWeekday | undefined {
  for (const weekday of WEEKDAYS) {
    const index = value.search(weekday.pattern);
    if (index >= 0) {
      return { cron: weekday.cron, label: weekday.label, index };
    }
  }
  return undefined;
}

function fallbackWeekday(
  reminderAt: string | undefined,
): ParsedWeekday | undefined {
  if (!reminderAt) return undefined;
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    weekday: "long",
  }).format(new Date(reminderAt));
  const weekday = WEEKDAYS.find((candidate) => candidate.label === label);
  if (!weekday) return undefined;
  return { cron: weekday.cron, label: weekday.label, index: 0 };
}

function parseMonthDay(value: string): number | undefined {
  const match = value.match(
    /\b(?:monthly|every month)(?:\s+on)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/u,
  );
  const day = parseInteger(match?.[1]);
  if (!day || day < 1 || day > 31) return undefined;
  return day;
}

function fallbackMonthDay(reminderAt: string | undefined): number | undefined {
  if (!reminderAt) return undefined;
  return pacificParts(new Date(reminderAt)).day;
}

function nthValue(value: string | undefined): number | undefined {
  switch (value?.toLocaleLowerCase()) {
    case "first":
    case "1st":
      return 1;
    case "second":
    case "2nd":
      return 2;
    case "third":
    case "3rd":
      return 3;
    case "fourth":
    case "4th":
      return 4;
    case "fifth":
    case "5th":
      return 5;
    default:
      return undefined;
  }
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number";
}

function formatNthList(values: readonly number[]): string {
  const labels = values.map(formatOrdinal);
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function formatOrdinal(value: number): string {
  const suffix =
    value % 10 === 1 && value % 100 !== 11
      ? "st"
      : value % 10 === 2 && value % 100 !== 12
        ? "nd"
        : value % 10 === 3 && value % 100 !== 13
          ? "rd"
          : "th";
  return `${value}${suffix}`;
}

function formatRepeatTime(time: RepeatTime): string {
  const hour12 = time.hour % 12 || 12;
  const minute = time.minute.toString().padStart(2, "0");
  const suffix = time.hour < 12 ? "AM" : "PM";
  return `${hour12}:${minute} ${suffix}`;
}

function parseReminderRepeatInput(
  value: string,
  reminderAt: string | undefined,
): ReminderRepeatParseResult {
  const trimmed = normalizeWhitespace(value).toLocaleLowerCase();
  if (!trimmed) return { kind: "none" };
  const time = parseRepeatTime(trimmed) ?? fallbackTime(reminderAt);
  if (!time) {
    return {
      kind: "invalid",
      message:
        "I need a time for the repeat. Try `daily 9am`, `weekly Mon 6pm`, or set a reminder date/time too.",
    };
  }

  const daily = parseDailyRepeat(trimmed, time);
  if (daily) return daily;

  const nthWeekday = parseNthWeekdayRepeat(trimmed, time);
  if (nthWeekday) return nthWeekday;

  const weekly = parseWeeklyRepeat(trimmed, time, reminderAt);
  if (weekly) return weekly;

  const monthly = parseMonthlyRepeat(trimmed, time, reminderAt);
  if (monthly) return monthly;

  return {
    kind: "invalid",
    message:
      "I couldn't understand that repeat. Try `daily 9am`, `weekdays 9am`, `weekly Mon 6pm`, `monthly 1st 10pm`, or `2nd and 4th Wed 6pm`.",
  };
}

function parseDailyRepeat(
  value: string,
  time: RepeatTime,
): ReminderRepeatParseResult | undefined {
  if (/\b(?:daily|every day)\b/u.test(value)) {
    return validRepeat(
      `${time.minute} ${time.hour} * * *`,
      `daily at ${formatRepeatTime(time)}`,
    );
  }
  if (/\b(?:weekdays|every weekday)\b/u.test(value)) {
    return validRepeat(
      `${time.minute} ${time.hour} * * MON-FRI`,
      `weekdays at ${formatRepeatTime(time)}`,
    );
  }
  return undefined;
}

function parseNthWeekdayRepeat(
  value: string,
  time: RepeatTime,
): ReminderRepeatParseResult | undefined {
  const weekday = parseWeekday(value);
  if (!weekday) return undefined;
  const beforeWeekday = value.slice(0, weekday.index);
  const nths = [...beforeWeekday.matchAll(NTH_TOKEN_PATTERN)]
    .map((match) => nthValue(match[1]))
    .filter(isNumber);
  if (nths.length === 0) return undefined;
  const unique = [...new Set(nths)].sort((a, b) => a - b);
  return validRepeat(
    `${time.minute} ${time.hour} * * ${unique.map((nth) => `${weekday.cron}#${nth}`).join(",")}`,
    `${formatNthList(unique)} ${weekday.label} at ${formatRepeatTime(time)}`,
  );
}

function parseWeeklyRepeat(
  value: string,
  time: RepeatTime,
  reminderAt: string | undefined,
): ReminderRepeatParseResult | undefined {
  const explicitWeekday = parseWeekday(value);
  if (!explicitWeekday && !/\b(?:weekly|every week)\b/u.test(value)) {
    return undefined;
  }
  const weekday = explicitWeekday ?? fallbackWeekday(reminderAt);
  if (!weekday) {
    return {
      kind: "invalid",
      message:
        "I need a weekday for that weekly repeat. Try `weekly Mon 6pm`, or include a reminder date/time whose weekday I can use.",
    };
  }
  return validRepeat(
    `${time.minute} ${time.hour} * * ${weekday.cron}`,
    `weekly on ${weekday.label} at ${formatRepeatTime(time)}`,
  );
}

function parseMonthlyRepeat(
  value: string,
  time: RepeatTime,
  reminderAt: string | undefined,
): ReminderRepeatParseResult | undefined {
  if (!/\b(?:monthly|every month)\b/u.test(value)) return undefined;
  const day = parseMonthDay(value) ?? fallbackMonthDay(reminderAt);
  if (!day) {
    return {
      kind: "invalid",
      message:
        "I need a day of the month for that monthly repeat. Try `monthly 1st 10pm`, or include a reminder date/time whose day I can use.",
    };
  }
  return validRepeat(
    `${time.minute} ${time.hour} ${day} * *`,
    `monthly on the ${formatOrdinal(day)} at ${formatRepeatTime(time)}`,
  );
}

function validRepeat(
  schedule: string,
  summary: string,
): ReminderRepeatParseResult {
  const recurrence: ReminderRecurrence = {
    schedule,
    timezone: PACIFIC_TIME_ZONE,
  };
  nextReminderAt(recurrence);
  return { kind: "valid", recurrence, summary };
}

function nextReminderAt(recurrence: ReminderRecurrence): Date {
  const next = nextRecurrenceRun(recurrence);
  if (!next) {
    throw new Error(
      `Repeat schedule has no future runs: ${recurrence.schedule}`,
    );
  }
  return next;
}

function futureReminderResult(iso: string): ReminderDateParseResult {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return {
      kind: "invalid",
      message: "That reminder date does not look valid.",
    };
  }
  if (timestamp <= Date.now()) {
    return {
      kind: "invalid",
      message: "That reminder date is in the past.",
    };
  }
  return { kind: "valid", iso };
}

function formatDiscordTimestamp(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return iso;
  return `<t:${Math.floor(timestamp / 1_000)}:f>`;
}

function generatedTodoReminderId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14);
  return `todo_${stamp}_${randomUUID().slice(0, 8)}`;
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function limitDisplayText(value: string): string {
  if (value.length <= DISPLAY_ITEM_LIMIT) return value;
  return `${value.slice(0, DISPLAY_ITEM_LIMIT - 1)}…`;
}

function limitOptionText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
