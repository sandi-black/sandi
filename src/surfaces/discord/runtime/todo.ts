import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { REST, Routes } from "discord.js";

import { z } from "zod/v4";
import { generateTimestampId } from "@/lib/ids";
import { JsonFileStore } from "@/lib/state/file-store";
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
  normalizeReminderId,
  readReminder,
  writeReminder,
} from "@/surfaces/discord/reminders/store";
import {
  currentDiscordReminderUser,
  readDiscordPlatformContext,
} from "@/surfaces/discord/runtime/context";
import { resolveGuildId } from "@/surfaces/discord/runtime/guild";
import { explicitChannelId } from "@/surfaces/discord/runtime/targets";
import {
  type ChannelTodoState,
  cleanItemText,
  emptyGuildState,
  formatTodoList,
  GuildTodoStateSchema,
  listForChannel,
  type TodoItem,
  type TodoListRef,
  updateGuildList,
} from "@/surfaces/discord/shared/todo-format";

const TODO_STATE_PATH = "todo-list/state.json";
const MAX_TODO_ITEMS = 10;
const DEFAULT_FOLLOWUP_INTERVAL_MINUTES = 60;

const TodoListStateSchema = z.object({
  guilds: z.record(z.string(), GuildTodoStateSchema),
});

const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  content: z.string(),
});

const DiscordContextSchema = z.object({
  platform: z.literal("discord"),
  guildId: z.string().optional(),
  channelId: z.string(),
  parentChannelId: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string(),
});

type TodoListState = z.infer<typeof TodoListStateSchema>;
type DiscordMessage = z.infer<typeof DiscordMessageSchema>;
type DiscordContext = z.infer<typeof DiscordContextSchema>;

export type TodoItemSummary = {
  id: string;
  text: string;
  authorName: string;
  sourceUrl?: string;
  reason?: string;
  createdAt: string;
  reminderAt?: string;
  reminderRepeat?: string;
  reminderId?: string;
};

export type AddTodoItemInput = {
  text: string;
  channel?: string;
  authorName?: string;
  sourceUrl?: string;
  reason?: string;
  reminderAt?: string;
  recurrence?: ReminderRecurrence;
  recurrenceSummary?: string;
  audienceUserIds?: string[];
  createdBy?: ReminderUser;
};

export type UpdateTodoItemInput = {
  itemId?: string;
  matchText?: string;
  channel?: string;
  text?: string;
  reason?: string | null;
  reminderAt?: string | null;
  recurrence?: ReminderRecurrence | null;
  recurrenceSummary?: string | null;
  audienceUserIds?: string[];
  updatedBy?: ReminderUser;
};

export type CompleteTodoItemInput = {
  itemId?: string;
  matchText?: string;
  channel?: string;
  doneBy?: ReminderUser;
};

export type RemoveTodoItemInput = {
  itemId?: string;
  matchText?: string;
  channel?: string;
};

export type TodoListResult = {
  channelId: string;
  messageId?: string;
  items: TodoItemSummary[];
};

const EMPTY_STATE: TodoListState = { guilds: {} };

export async function listItems(
  input: { channel?: string } = {},
): Promise<TodoListResult> {
  const { guildId, channelId } = currentTodoTarget(input.channel);
  const state = await store().read(EMPTY_STATE);
  const current = state.guilds[guildId] ?? emptyGuildState();
  const list =
    listForChannel(current, channelId)?.list ?? emptyChannelList(channelId);
  return todoListResult(list);
}

export async function addItem(
  input: AddTodoItemInput,
): Promise<TodoListResult> {
  const text = cleanItemText(input.text);
  if (!text) throw new Error("Todo text is empty.");
  const { guildId, channelId } = currentTodoTarget(input.channel);
  const sourceUrl = input.sourceUrl;
  const reminderPlan = await createReminderPlan({
    channelId,
    text,
    reminderAt: input.reminderAt,
    recurrence: input.recurrence,
    recurrenceSummary: input.recurrenceSummary,
    audienceUserIds: input.audienceUserIds,
    createdBy: input.createdBy ?? currentDiscordReminderUser(),
  });

  return updateStoredList(guildId, channelId, async (list) => {
    if (list.items.length >= MAX_TODO_ITEMS) {
      throw new Error(`This todo list is full at ${MAX_TODO_ITEMS} items.`);
    }
    const itemInput = {
      id: randomUUID(),
      text,
      authorName: input.authorName ?? "Sandi",
      sourceUrl,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    const item = buildTodoItem(
      reminderPlan ? { ...itemInput, reminderPlan } : itemInput,
    );
    return { ...list, items: [...list.items, item] };
  });
}

export async function updateItem(
  input: UpdateTodoItemInput,
): Promise<TodoListResult> {
  const { guildId, channelId } = currentTodoTarget(input.channel);
  return updateStoredList(guildId, channelId, async (list) => {
    const item = findOneItem(list.items, input);
    const text =
      input.text === undefined ? item.text : cleanItemText(input.text);
    if (!text) throw new Error("Updated todo text is empty.");
    const reminderPlan = await updateReminderPlan({
      channelId,
      item,
      text,
      reminderAt: input.reminderAt,
      recurrence: input.recurrence,
      recurrenceSummary: input.recurrenceSummary,
      audienceUserIds: input.audienceUserIds,
      updatedBy: input.updatedBy,
    });
    const itemInput = {
      id: item.id,
      text,
      authorName: item.authorName,
      sourceUrl: item.sourceUrl,
      reason: input.reason === undefined ? item.reason : nullish(input.reason),
      createdAt: item.createdAt,
    };
    const updated = buildTodoItem(
      reminderPlan ? { ...itemInput, reminderPlan } : itemInput,
    );
    return replaceItem(list, updated);
  });
}

export async function completeItem(
  input: CompleteTodoItemInput,
): Promise<TodoListResult> {
  const { guildId, channelId } = currentTodoTarget(input.channel);
  return updateStoredList(guildId, channelId, async (list) => {
    const item = findOneItem(list.items, input);
    const nextItem = await completedRecurringItem(item, input.doneBy);
    if (nextItem) return replaceItem(list, nextItem);
    return {
      ...list,
      items: list.items.filter((candidate) => candidate.id !== item.id),
    };
  });
}

export async function removeItem(
  input: RemoveTodoItemInput,
): Promise<TodoListResult> {
  const { guildId, channelId } = currentTodoTarget(input.channel);
  return updateStoredList(guildId, channelId, async (list) => {
    const item = findOneItem(list.items, input);
    if (item.reminderId) await deleteReminder(remindersRoot(), item.reminderId);
    return {
      ...list,
      items: list.items.filter((candidate) => candidate.id !== item.id),
    };
  });
}

async function updateStoredList(
  guildId: string,
  channelId: string,
  mutator: (list: ChannelTodoState) => Promise<ChannelTodoState>,
): Promise<TodoListResult> {
  // Read, mutate, render, and write run inside one cross-process lock so a
  // concurrent todo turn in another process cannot lose this update. The
  // render performs Discord I/O while the lock is held; the heartbeat keeps the
  // lock alive for the duration, so no waiter steals it.
  let next: ChannelTodoState | undefined;
  await store().updateManaged(async (state) => {
    const current = state.guilds[guildId] ?? emptyGuildState();
    const ref = listForChannel(current, channelId);
    const existing = ref?.list ?? emptyChannelList(channelId);
    const mutated = await upsertRenderedList(await mutator(existing));
    next = mutated;
    // Preserve the slot (legacy vs the per-channel map) the list was already
    // living in; a brand-new list not found by listForChannel always lands in
    // the map, matching listForChannel's own map-first lookup order.
    const nextRef: TodoListRef =
      ref?.kind === "legacy"
        ? { kind: "legacy", list: mutated }
        : { kind: "channel", channelId, list: mutated };
    return {
      guilds: {
        ...state.guilds,
        [guildId]: updateGuildList(current, nextRef),
      },
    };
  }, EMPTY_STATE);
  if (!next) throw new Error("todo update produced no list");
  return todoListResult(next);
}

async function createReminderPlan(input: {
  channelId: string;
  text: string;
  reminderAt: string | undefined;
  recurrence: ReminderRecurrence | undefined;
  recurrenceSummary: string | undefined;
  audienceUserIds: string[] | undefined;
  createdBy: ReminderUser | undefined;
}): Promise<ReminderPlan | undefined> {
  const reminderAt = input.reminderAt ?? nextReminderAt(input.recurrence);
  if (!reminderAt) return undefined;
  const reminderId = generatedTodoReminderId();
  await writeReminder(
    remindersRoot(),
    reminderId,
    buildReminder({
      channelId: input.channelId,
      text: input.text,
      at: reminderAt,
      recurrence: input.recurrence,
      audienceUserIds: input.audienceUserIds,
      createdBy: input.createdBy,
    }),
  );
  return buildReminderPlan({
    id: reminderId,
    at: reminderAt,
    recurrenceSummary: input.recurrenceSummary,
  });
}

async function updateReminderPlan(input: {
  channelId: string;
  item: TodoItem;
  text: string;
  reminderAt: string | null | undefined;
  recurrence: ReminderRecurrence | null | undefined;
  recurrenceSummary: string | null | undefined;
  audienceUserIds: string[] | undefined;
  updatedBy: ReminderUser | undefined;
}): Promise<ReminderPlan | undefined> {
  const existing = input.item.reminderId
    ? await readReminderSafely(input.item.reminderId)
    : undefined;
  const recurrence =
    input.recurrence === undefined
      ? existing?.recurrence
      : nullish(input.recurrence);
  const reminderAt =
    input.reminderAt === undefined
      ? input.item.reminderAt
      : nullish(input.reminderAt);
  const nextAt = reminderAt ?? nextReminderAt(recurrence);
  if (!nextAt) {
    if (input.item.reminderId)
      await deleteReminder(remindersRoot(), input.item.reminderId);
    return undefined;
  }

  const reminderId = input.item.reminderId ?? generatedTodoReminderId();
  await writeReminder(
    remindersRoot(),
    reminderId,
    buildReminder({
      channelId: input.channelId,
      text: input.text,
      at: nextAt,
      recurrence,
      audienceUserIds: input.audienceUserIds ?? existing?.audienceUserIds,
      createdBy:
        input.updatedBy ?? existing?.createdBy ?? currentDiscordReminderUser(),
    }),
  );
  return buildReminderPlan({
    id: reminderId,
    at: nextAt,
    recurrenceSummary:
      input.recurrenceSummary === undefined
        ? input.item.reminderRepeat
        : nullish(input.recurrenceSummary),
  });
}

async function completedRecurringItem(
  item: TodoItem,
  doneBy: ReminderUser | undefined,
): Promise<TodoItem | undefined> {
  if (!item.reminderId) return undefined;
  const reminder = await readReminderSafely(item.reminderId);
  if (reminder?.status !== "active") return undefined;
  const completed = completedReminder(reminder, doneBy);
  await writeReminder(remindersRoot(), item.reminderId, completed);
  if (completed.status !== "active") return undefined;
  const reminderPlan = buildReminderPlan({
    id: item.reminderId,
    at: completed.nextFireAt,
    recurrenceSummary: item.reminderRepeat,
  });
  return buildTodoItem({
    id: item.id,
    text: item.text,
    authorName: item.authorName,
    sourceUrl: item.sourceUrl,
    reason: item.reason,
    createdAt: item.createdAt,
    reminderPlan,
  });
}

async function readReminderSafely(id: string): Promise<Reminder | undefined> {
  try {
    return await readReminder(remindersRoot(), id);
  } catch {
    return undefined;
  }
}

function buildReminder(input: {
  channelId: string;
  text: string;
  at: string;
  recurrence: ReminderRecurrence | undefined;
  audienceUserIds: string[] | undefined;
  createdBy: ReminderUser | undefined;
}): Reminder {
  if (input.recurrence) validateReminderRecurrence(input.recurrence);
  const targetTime = new Date(input.at).getTime();
  if (!Number.isFinite(targetTime)) {
    throw new Error(`Invalid reminder timestamp: ${input.at}`);
  }
  return {
    target: reminderTarget(input.channelId),
    text: `Todo: ${input.text}`,
    createdAt: new Date().toISOString(),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    audienceUserIds: input.audienceUserIds ?? [],
    status: "active",
    nextFireAt: input.at,
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    followupIntervalMinutes: DEFAULT_FOLLOWUP_INTERVAL_MINUTES,
    fireCount: 0,
    messageRefs: [],
  };
}

function reminderTarget(channelId: string): ReminderTarget {
  return { kind: "channel", channelId };
}

type ReminderPlan = {
  id: string;
  at: string;
  recurrenceSummary?: string;
};

function buildReminderPlan(input: {
  id: string;
  at: string;
  recurrenceSummary: string | undefined;
}): ReminderPlan {
  const base = { id: input.id, at: input.at };
  return input.recurrenceSummary
    ? { ...base, recurrenceSummary: input.recurrenceSummary }
    : base;
}

function buildTodoItem(input: {
  id: string;
  text: string;
  authorName: string;
  sourceUrl: string | undefined;
  reason: string | undefined;
  createdAt: string;
  reminderPlan?: ReminderPlan;
}): TodoItem {
  const base = {
    id: input.id,
    text: input.text,
    authorName: input.authorName,
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
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

function findOneItem(
  items: readonly TodoItem[],
  input: { itemId?: string; matchText?: string },
): TodoItem {
  if (input.itemId) {
    const item = items.find((candidate) => candidate.id === input.itemId);
    if (!item) throw new Error(`No todo item found with id ${input.itemId}.`);
    return item;
  }
  const query = input.matchText?.trim().toLocaleLowerCase();
  if (!query) throw new Error("Provide itemId or matchText.");
  const matches = items.filter((item) =>
    item.text.toLocaleLowerCase().includes(query),
  );
  if (matches.length === 0) {
    throw new Error(`No todo item matched ${input.matchText}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple todo items matched ${input.matchText}; use listItems and pass itemId.`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error(`No todo item matched ${input.matchText}.`);
  return match;
}

function replaceItem(
  list: ChannelTodoState,
  updated: TodoItem,
): ChannelTodoState {
  return {
    ...list,
    items: list.items.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    ),
  };
}

async function upsertRenderedList(
  list: ChannelTodoState,
): Promise<ChannelTodoState> {
  const rest = createRest();
  if (list.messageId) {
    try {
      const edited = await discordPatchMessage(
        rest,
        list.channelId,
        list.messageId,
        {
          content: formatTodoList(list),
          components: todoComponents(list),
          allowed_mentions: { parse: [] },
        },
      );
      return { ...list, messageId: edited.id };
    } catch {}
  }

  const sent = await discordPostMessage(rest, list.channelId, {
    content: formatTodoList(list),
    allowed_mentions: { parse: [] },
  });
  const listWithMessage = { ...list, messageId: sent.id };
  await discordPatchMessage(rest, list.channelId, sent.id, {
    content: formatTodoList(listWithMessage),
    components: todoComponents(listWithMessage),
    allowed_mentions: { parse: [] },
  });
  await pinMessageSafely(rest, list.channelId, sent.id);
  return { ...list, channelId: sent.channel_id, messageId: sent.id };
}

async function discordPostMessage(
  rest: REST,
  channelId: string,
  body: Record<string, unknown>,
): Promise<DiscordMessage> {
  return DiscordMessageSchema.parse(
    await rest.post(Routes.channelMessages(channelId), { body }),
  );
}

async function discordPatchMessage(
  rest: REST,
  channelId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<DiscordMessage> {
  return DiscordMessageSchema.parse(
    await rest.patch(Routes.channelMessage(channelId, messageId), { body }),
  );
}

async function pinMessageSafely(
  rest: REST,
  channelId: string,
  messageId: string,
): Promise<void> {
  try {
    await rest.put(Routes.channelMessagesPin(channelId, messageId), {
      reason: "Created todo list message",
    });
  } catch {}
}

function todoComponents(list: ChannelTodoState): unknown[] {
  if (!list.messageId) return [];
  if (list.completionMode === "buttons") {
    return itemDoneButtonRows(list.messageId, list.items);
  }
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: `t:add:${list.messageId}`,
          label: list.items.length >= MAX_TODO_ITEMS ? "List full" : "Add item",
          disabled: list.items.length >= MAX_TODO_ITEMS,
        },
        {
          type: 2,
          style: 3,
          custom_id: `t:done:${list.messageId}`,
          label: "Complete item",
          disabled: list.items.length === 0,
        },
        {
          type: 2,
          style: 2,
          custom_id: `t:ref:${list.messageId}`,
          label: "Refresh",
        },
      ],
    },
  ];
}

function itemDoneButtonRows(
  messageId: string,
  items: readonly TodoItem[],
): unknown[] {
  const rows: { type: 1; components: unknown[] }[] = [];
  for (const item of items.slice(0, 25)) {
    const row = rows.at(-1);
    const targetRow =
      row && row.components.length < 5
        ? row
        : { type: 1 as const, components: [] };
    if (targetRow !== row) rows.push(targetRow);
    targetRow.components.push({
      type: 2,
      style: 3,
      custom_id: `t:itemdone:${messageId}:${item.id}`,
      label: limitOptionText(`Done: ${item.text}`, 80),
    });
  }
  return rows;
}

function limitOptionText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function todoListResult(list: ChannelTodoState): TodoListResult {
  const result = {
    channelId: list.channelId,
    items: list.items.map(todoItemSummary),
  };
  return list.messageId ? { ...result, messageId: list.messageId } : result;
}

function todoItemSummary(item: TodoItem): TodoItemSummary {
  return {
    id: item.id,
    text: item.text,
    authorName: item.authorName,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    createdAt: item.createdAt,
    ...(item.reminderAt ? { reminderAt: item.reminderAt } : {}),
    ...(item.reminderRepeat ? { reminderRepeat: item.reminderRepeat } : {}),
    ...(item.reminderId ? { reminderId: item.reminderId } : {}),
  };
}

function emptyChannelList(channelId: string): ChannelTodoState {
  return { channelId, targetKind: "channel", items: [] };
}

function currentTodoTarget(channelRef: string | undefined): {
  guildId: string;
  channelId: string;
} {
  const context = optionalContext();
  const guildId = resolveGuildId(context?.guildId);
  const channelId = channelRef
    ? explicitChannelId(channelRef)
    : (context?.threadId ?? context?.channelId);
  if (!channelId) {
    throw new Error(
      "Todo helpers need a channel: pass an explicit channel on a turn from another surface, or run them from a Discord turn.",
    );
  }
  return { guildId, channelId };
}

// The current Discord context, or undefined on a turn from another surface
// where every todo helper must name an explicit channel target.
function optionalContext(): DiscordContext | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  return DiscordContextSchema.parse(JSON.parse(raw));
}

function createRest(): REST {
  const token =
    process.env["DISCORD_BOT_TOKEN"]?.trim() ||
    process.env["DISCORD_TOKEN"]?.trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required.");
  return new REST({ version: "10" }).setToken(token);
}

function store(): JsonFileStore<TodoListState> {
  return new JsonFileStore(
    join(dataDir(), TODO_STATE_PATH),
    TodoListStateSchema,
  );
}

function dataDir(): string {
  return process.env["SANDI_DATA_DIR"]?.trim() || "data";
}

function remindersRoot(): string {
  return (
    process.env["SANDI_REMINDERS_ROOT"]?.trim() ||
    `${process.env["SANDI_DATA_DIR"]?.trim() || "data"}/reminders`
  );
}

function nextReminderAt(
  recurrence: ReminderRecurrence | null | undefined,
): string | undefined {
  if (!recurrence) return undefined;
  validateReminderRecurrence(recurrence);
  return nextRecurrenceRun(recurrence)?.toISOString();
}

function generatedTodoReminderId(): string {
  return normalizeReminderId(generateTimestampId("todo"));
}

function nullish<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
