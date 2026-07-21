import { randomUUID } from "node:crypto";

import { z } from "zod/v4";
import { generateTimestampId } from "@/lib/ids";
import type { JsonFileStore } from "@/lib/state/file-store";
import {
  completedReminder,
  nextRecurrenceRun,
  validateReminderRecurrence,
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
import {
  type ChannelTodoState,
  emptyGuildState,
  type GuildTodoState,
  GuildTodoStateSchema,
  legacyList,
  listForChannel,
  type TodoItem,
  type TodoListRef,
  updateGuildList,
} from "@/surfaces/discord/shared/todo-format";

export const MAX_TODO_ITEMS = 10;
const DEFAULT_FOLLOWUP_INTERVAL_MINUTES = 60;

export const TodoListStateSchema = z.object({
  guilds: z.record(z.string(), GuildTodoStateSchema),
});
export type TodoListState = z.infer<typeof TodoListStateSchema>;
export const EMPTY_TODO_STATE: TodoListState = { guilds: {} };

export type TodoListSelector = { channelId: string } | { messageId: string };
export type TodoItemSelector =
  | { itemId: string; matchText?: never }
  | { itemId?: never; matchText: string };

export type TodoMutationResult = {
  list: ChannelTodoState;
  item: TodoItem;
};

export class TodoListNotFoundError extends Error {}
export class TodoItemNotFoundError extends Error {}
export class TodoListFullError extends Error {}

export type TodoApplicationOptions = {
  store: JsonFileStore<TodoListState>;
  remindersRoot: string;
  renderList: (list: ChannelTodoState) => Promise<ChannelTodoState>;
  currentUser?: () => ReminderUser | undefined;
  now?: () => Date;
  newItemId?: () => string;
  newReminderId?: () => string;
};

type ReminderFields = {
  reminderAt?: string | null | undefined;
  recurrence?: ReminderRecurrence | null | undefined;
  recurrenceSummary?: string | null | undefined;
  audienceUserIds?: string[] | undefined;
  user?: ReminderUser | undefined;
};

export class TodoApplication {
  readonly #store: JsonFileStore<TodoListState>;
  readonly #remindersRoot: string;
  readonly #renderList: (list: ChannelTodoState) => Promise<ChannelTodoState>;
  readonly #currentUser: () => ReminderUser | undefined;
  readonly #now: () => Date;
  readonly #newItemId: () => string;
  readonly #newReminderId: () => string;

  constructor(options: TodoApplicationOptions) {
    this.#store = options.store;
    this.#remindersRoot = options.remindersRoot;
    this.#renderList = options.renderList;
    this.#currentUser = options.currentUser ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#newItemId = options.newItemId ?? randomUUID;
    this.#newReminderId =
      options.newReminderId ?? (() => generateTimestampId("todo"));
  }

  async list(
    guildId: string,
    selector: TodoListSelector,
  ): Promise<ChannelTodoState | undefined> {
    const state = await this.#store.read(EMPTY_TODO_STATE);
    const guild = state.guilds[guildId] ?? emptyGuildState();
    return locateList(guild, selector, false)?.list;
  }

  async configure(input: {
    guildId: string;
    list: TodoListSelector;
    title?: string | null | undefined;
    instructions?: string | null | undefined;
    emptyText?: string | null | undefined;
    completionMode?: "select" | "buttons" | null | undefined;
    displayMode?: "default" | "grouped-reminders" | null | undefined;
    render?: boolean | undefined;
  }): Promise<ChannelTodoState> {
    let result: ChannelTodoState | undefined;
    await this.#store.updateManaged(async (state) => {
      const current = state.guilds[input.guildId] ?? emptyGuildState();
      const ref = locateList(current, input.list, false);
      if (!ref) {
        throw new TodoListNotFoundError("That todo list is no longer current.");
      }
      const configured = configureList(ref.list, input);
      const rendered =
        input.render === false
          ? configured
          : await this.#renderList(configured);
      result = rendered;
      return {
        guilds: {
          ...state.guilds,
          [input.guildId]: updateGuildList(current, {
            ...ref,
            list: rendered,
          }),
        },
      };
    }, EMPTY_TODO_STATE);
    if (!result) throw new Error("todo configuration produced no result");
    return result;
  }

  async add(input: {
    guildId: string;
    list: TodoListSelector;
    id?: string | undefined;
    text: string;
    authorName: string;
    sourceUrl?: string | undefined;
    reason?: string | undefined;
    createdAt?: string | undefined;
    reminderAt?: string | undefined;
    recurrence?: ReminderRecurrence | undefined;
    recurrenceSummary?: string | undefined;
    audienceUserIds?: string[] | undefined;
    createdBy?: ReminderUser | undefined;
    render?: boolean | undefined;
  }): Promise<TodoMutationResult> {
    return this.#mutate(
      input.guildId,
      input.list,
      true,
      input.render !== false,
      async (list) => {
        if (list.items.length >= MAX_TODO_ITEMS) {
          throw new TodoListFullError(
            `This todo list is full at ${MAX_TODO_ITEMS} items.`,
          );
        }
        const reminder = await this.#createReminder(list, {
          text: input.text,
          reminderAt: input.reminderAt,
          recurrence: input.recurrence,
          recurrenceSummary: input.recurrenceSummary,
          audienceUserIds: input.audienceUserIds,
          user: input.createdBy,
        });
        const item = todoItem({
          id: input.id ?? this.#newItemId(),
          text: input.text,
          authorName: input.authorName,
          sourceUrl: input.sourceUrl,
          reason: input.reason,
          createdAt: input.createdAt ?? this.#now().toISOString(),
          reminder,
        });
        return { list: { ...list, items: [...list.items, item] }, item };
      },
    );
  }

  async update(input: {
    guildId: string;
    list: TodoListSelector;
    item: TodoItemSelector;
    text?: string | undefined;
    reason?: string | null | undefined;
    reminderAt?: string | null | undefined;
    recurrence?: ReminderRecurrence | null | undefined;
    recurrenceSummary?: string | null | undefined;
    audienceUserIds?: string[] | undefined;
    updatedBy?: ReminderUser | undefined;
    render?: boolean | undefined;
  }): Promise<TodoMutationResult> {
    return this.#mutate(
      input.guildId,
      input.list,
      false,
      input.render !== false,
      async (list) => {
        const item = findOneItem(list.items, input.item);
        const text = input.text ?? item.text;
        const reminder = await this.#updateReminder(list, item, {
          text,
          reminderAt: input.reminderAt,
          recurrence: input.recurrence,
          recurrenceSummary: input.recurrenceSummary,
          audienceUserIds: input.audienceUserIds,
          user: input.updatedBy,
        });
        const updated = todoItem({
          id: item.id,
          text,
          authorName: item.authorName,
          sourceUrl: item.sourceUrl,
          reason:
            input.reason === undefined ? item.reason : nullish(input.reason),
          createdAt: item.createdAt,
          reminder,
        });
        return { list: replaceItem(list, updated), item: updated };
      },
    );
  }

  async complete(input: {
    guildId: string;
    list: TodoListSelector;
    item: TodoItemSelector;
    doneBy?: ReminderUser | undefined;
    render?: boolean | undefined;
  }): Promise<TodoMutationResult> {
    return this.#mutate(
      input.guildId,
      input.list,
      false,
      input.render !== false,
      async (list) => {
        const item = findOneItem(list.items, input.item);
        const recurring = await this.#completeReminder(item, input.doneBy);
        return recurring
          ? { list: replaceItem(list, recurring), item: recurring }
          : {
              list: {
                ...list,
                items: list.items.filter(
                  (candidate) => candidate.id !== item.id,
                ),
              },
              item,
            };
      },
    );
  }

  async remove(input: {
    guildId: string;
    list: TodoListSelector;
    item: TodoItemSelector;
    render?: boolean | undefined;
  }): Promise<TodoMutationResult> {
    return this.#mutate(
      input.guildId,
      input.list,
      false,
      input.render !== false,
      async (list) => {
        const item = findOneItem(list.items, input.item);
        if (item.reminderId) {
          await deleteReminder(this.#remindersRoot, item.reminderId);
        }
        return {
          list: {
            ...list,
            items: list.items.filter((candidate) => candidate.id !== item.id),
          },
          item,
        };
      },
    );
  }

  async removeCompletedOneTimeReminder(reminderId: string): Promise<boolean> {
    let removed = false;
    await this.#store.updateManaged(async (state) => {
      let guilds = state.guilds;
      for (const [guildId, current] of Object.entries(state.guilds)) {
        let nextGuild = current;
        for (const [channelId, list] of Object.entries(current.lists ?? {})) {
          const next = await this.#removeReminderFromList(list, reminderId);
          if (!next) continue;
          nextGuild = updateGuildList(nextGuild, {
            kind: "channel",
            channelId,
            list: next,
          });
          removed = true;
        }
        if (nextGuild.messageId) {
          const legacy = await this.#removeReminderFromList(
            legacyList(nextGuild),
            reminderId,
          );
          if (legacy) {
            nextGuild = updateGuildList(nextGuild, {
              kind: "legacy",
              list: legacy,
            });
            removed = true;
          }
        }
        if (nextGuild !== current) guilds = { ...guilds, [guildId]: nextGuild };
      }
      return removed ? { guilds } : state;
    }, EMPTY_TODO_STATE);
    return removed;
  }

  async #mutate(
    guildId: string,
    selector: TodoListSelector,
    create: boolean,
    render: boolean,
    operation: (
      list: ChannelTodoState,
    ) => Promise<{ list: ChannelTodoState; item: TodoItem }>,
  ): Promise<TodoMutationResult> {
    let result: TodoMutationResult | undefined;
    await this.#store.updateManaged(async (state) => {
      const current = state.guilds[guildId] ?? emptyGuildState();
      const ref = locateList(current, selector, create);
      if (!ref) {
        throw new TodoListNotFoundError("That todo list is no longer current.");
      }
      const mutated = await operation(ref.list);
      const rendered = render
        ? await this.#renderList(mutated.list)
        : mutated.list;
      result = { list: rendered, item: mutated.item };
      return {
        guilds: {
          ...state.guilds,
          [guildId]: updateGuildList(current, { ...ref, list: rendered }),
        },
      };
    }, EMPTY_TODO_STATE);
    if (!result) throw new Error("todo mutation produced no result");
    return result;
  }

  async #createReminder(
    list: ChannelTodoState,
    input: ReminderFields & { text: string },
  ): Promise<ReminderPlan | undefined> {
    const at = input.reminderAt ?? nextReminderAt(input.recurrence);
    if (!at) return undefined;
    const id = this.#newReminderId();
    await writeReminder(
      this.#remindersRoot,
      id,
      this.#reminder(list, input.text, at, input),
    );
    return reminderPlan(id, at, nullish(input.recurrenceSummary));
  }

  async #updateReminder(
    list: ChannelTodoState,
    item: TodoItem,
    input: ReminderFields & { text: string },
  ): Promise<ReminderPlan | undefined> {
    const existing = item.reminderId
      ? await this.#readReminderSafely(item.reminderId)
      : undefined;
    const recurrence =
      input.recurrence === undefined
        ? existing?.recurrence
        : nullish(input.recurrence);
    const at =
      input.reminderAt === undefined
        ? item.reminderAt
        : nullish(input.reminderAt);
    const nextAt = at ?? nextReminderAt(recurrence);
    if (!nextAt) {
      if (item.reminderId) {
        await deleteReminder(this.#remindersRoot, item.reminderId);
      }
      return undefined;
    }
    const id = item.reminderId ?? this.#newReminderId();
    await writeReminder(
      this.#remindersRoot,
      id,
      this.#reminder(list, input.text, nextAt, {
        ...input,
        recurrence,
        audienceUserIds: input.audienceUserIds ?? existing?.audienceUserIds,
        user: input.user ?? existing?.createdBy ?? this.#currentUser(),
      }),
    );
    return reminderPlan(
      id,
      nextAt,
      input.recurrenceSummary === undefined
        ? item.reminderRepeat
        : nullish(input.recurrenceSummary),
    );
  }

  async #completeReminder(
    item: TodoItem,
    doneBy: ReminderUser | undefined,
  ): Promise<TodoItem | undefined> {
    if (!item.reminderId) return undefined;
    const reminder = await this.#readReminderSafely(item.reminderId);
    if (reminder?.status !== "active") return undefined;
    const completed = completedReminder(reminder, doneBy);
    await writeReminder(this.#remindersRoot, item.reminderId, completed);
    if (completed.status !== "active") return undefined;
    return todoItem({
      ...item,
      reminder: reminderPlan(
        item.reminderId,
        completed.nextFireAt,
        item.reminderRepeat,
      ),
    });
  }

  #reminder(
    list: ChannelTodoState,
    text: string,
    at: string,
    input: ReminderFields,
  ): Reminder {
    const recurrence = nullish(input.recurrence);
    if (recurrence) validateReminderRecurrence(recurrence);
    if (!Number.isFinite(new Date(at).getTime())) {
      throw new Error(`Invalid reminder timestamp: ${at}`);
    }
    const user = input.user ?? this.#currentUser();
    return {
      target: reminderTarget(list),
      text: `Todo: ${text}`,
      createdAt: this.#now().toISOString(),
      ...(user ? { createdBy: user } : {}),
      audienceUserIds: input.audienceUserIds ?? [],
      status: "active",
      nextFireAt: at,
      ...(recurrence ? { recurrence } : {}),
      followupIntervalMinutes: DEFAULT_FOLLOWUP_INTERVAL_MINUTES,
      fireCount: 0,
      messageRefs: [],
    };
  }

  async #readReminderSafely(id: string): Promise<Reminder | undefined> {
    try {
      return await readReminder(this.#remindersRoot, id);
    } catch {
      return undefined;
    }
  }

  async #removeReminderFromList(
    list: ChannelTodoState,
    reminderId: string,
  ): Promise<ChannelTodoState | undefined> {
    const items = list.items.filter(
      (item) => item.reminderId !== reminderId || Boolean(item.reminderRepeat),
    );
    if (items.length === list.items.length) return undefined;
    return this.#renderList({ ...list, items });
  }
}

function configureList(
  list: ChannelTodoState,
  input: {
    title?: string | null | undefined;
    instructions?: string | null | undefined;
    emptyText?: string | null | undefined;
    completionMode?: "select" | "buttons" | null | undefined;
    displayMode?: "default" | "grouped-reminders" | null | undefined;
  },
): ChannelTodoState {
  const configured = { ...list };
  setOptional(configured, "title", input.title);
  setOptional(configured, "instructions", input.instructions);
  setOptional(configured, "emptyText", input.emptyText);
  setOptional(configured, "completionMode", input.completionMode);
  setOptional(configured, "displayMode", input.displayMode);
  return configured;
}

function setOptional<
  Key extends
    | "title"
    | "instructions"
    | "emptyText"
    | "completionMode"
    | "displayMode",
>(
  list: ChannelTodoState,
  key: Key,
  value: ChannelTodoState[Key] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete list[key];
    return;
  }
  list[key] = value;
}

function locateList(
  guild: GuildTodoState,
  selector: TodoListSelector,
  create: boolean,
): TodoListRef | undefined {
  if ("messageId" in selector)
    return findListByMessageId(guild, selector.messageId);
  const existing = listForChannel(guild, selector.channelId);
  if (existing || !create) return existing;
  return {
    kind: "channel",
    channelId: selector.channelId,
    list: { channelId: selector.channelId, items: [] },
  };
}

export function findListByMessageId(
  guild: GuildTodoState,
  messageId: string,
): TodoListRef | undefined {
  for (const [channelId, list] of Object.entries(guild.lists ?? {})) {
    if (list.messageId === messageId) {
      return { kind: "channel", channelId, list };
    }
  }
  return guild.messageId === messageId
    ? { kind: "legacy", list: legacyList(guild) }
    : undefined;
}

function findOneItem(
  items: readonly TodoItem[],
  selector: TodoItemSelector,
): TodoItem {
  if ("itemId" in selector && selector.itemId) {
    const item = items.find((candidate) => candidate.id === selector.itemId);
    if (!item) {
      throw new TodoItemNotFoundError(
        `No todo item found with id ${selector.itemId}.`,
      );
    }
    return item;
  }
  const matchText = selector.matchText;
  if (!matchText) throw new Error("Provide itemId or matchText.");
  const query = matchText.toLocaleLowerCase();
  const matches = items.filter((item) =>
    item.text.toLocaleLowerCase().includes(query),
  );
  if (matches.length === 0) {
    throw new TodoItemNotFoundError(`No todo item matched ${matchText}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple todo items matched ${matchText}; use listItems and pass itemId.`,
    );
  }
  const [item] = matches;
  if (!item) {
    throw new TodoItemNotFoundError(`No todo item matched ${matchText}.`);
  }
  return item;
}

type ReminderPlan = { id: string; at: string; recurrenceSummary?: string };

function reminderPlan(
  id: string,
  at: string,
  recurrenceSummary: string | undefined,
): ReminderPlan {
  return recurrenceSummary ? { id, at, recurrenceSummary } : { id, at };
}

function todoItem(input: {
  id: string;
  text: string;
  authorName: string;
  sourceUrl?: string | undefined;
  reason?: string | undefined;
  createdAt: string;
  reminder?: ReminderPlan | undefined;
}): TodoItem {
  return {
    id: input.id,
    text: input.text,
    authorName: input.authorName,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: input.createdAt,
    ...(input.reminder
      ? {
          reminderAt: input.reminder.at,
          ...(input.reminder.recurrenceSummary
            ? { reminderRepeat: input.reminder.recurrenceSummary }
            : {}),
          reminderId: input.reminder.id,
        }
      : {}),
  };
}

function replaceItem(list: ChannelTodoState, item: TodoItem): ChannelTodoState {
  return {
    ...list,
    items: list.items.map((candidate) =>
      candidate.id === item.id ? item : candidate,
    ),
  };
}

function reminderTarget(list: ChannelTodoState): ReminderTarget {
  return list.targetKind === "thread"
    ? { kind: "thread", threadId: list.channelId }
    : { kind: "channel", channelId: list.channelId };
}

function nextReminderAt(
  recurrence: ReminderRecurrence | null | undefined,
): string | undefined {
  if (!recurrence) return undefined;
  validateReminderRecurrence(recurrence);
  return nextRecurrenceRun(recurrence)?.toISOString();
}

function nullish<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}
