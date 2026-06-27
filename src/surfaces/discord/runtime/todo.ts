import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { REST, Routes } from "discord.js";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";
import {
  nextRecurrenceRun,
  nextReminderRecurrenceRun,
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
import { readDiscordPlatformContext } from "@/surfaces/discord/runtime/context";
import { resolveGuildId } from "@/surfaces/discord/runtime/guild";
import { explicitChannelId } from "@/surfaces/discord/runtime/targets";

const TODO_STATE_PATH = "todo-list/state.json";
const DISCORD_MESSAGE_LIMIT = 2_000;
const DISPLAY_ITEM_LIMIT = 160;
const MAX_TODO_ITEMS = 10;
const DEFAULT_FOLLOWUP_INTERVAL_MINUTES = 60;
const PACIFIC_TIME_ZONE = "America/Los_Angeles";

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

const GuildTodoStateSchema = z.object({
  channelId: z.string().optional(),
  messageId: z.string().optional(),
  items: z.array(TodoItemSchema),
  lists: z.record(z.string(), ChannelTodoStateSchema).optional(),
});

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

type TodoItem = z.infer<typeof TodoItemSchema>;
type ChannelTodoState = z.infer<typeof ChannelTodoStateSchema>;
type GuildTodoState = z.infer<typeof GuildTodoStateSchema>;
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
    listForChannel(current, channelId) ?? emptyChannelList(channelId);
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
    const existing =
      listForChannel(current, channelId) ?? emptyChannelList(channelId);
    next = await upsertRenderedList(await mutator(existing));
    return {
      guilds: {
        ...state.guilds,
        [guildId]: updateGuildList(current, next),
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

function completedReminder(
  reminder: Reminder,
  doneBy: ReminderUser | undefined,
): Reminder {
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
      ...(doneBy ? { doneBy } : {}),
    };
  }
  return {
    ...reminder,
    status: "done",
    doneAt: completedAt.toISOString(),
    ...(doneBy ? { doneBy } : {}),
  };
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

  const visibleItems: TodoItem[] = [];
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
  const lines = list.instructions
    ? [`# ${title}`, "", list.instructions, ""]
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

function formatDiscordTimestamp(iso: string): string {
  const epochSeconds = Math.floor(new Date(iso).getTime() / 1_000);
  if (!Number.isFinite(epochSeconds)) return iso;
  return `<t:${epochSeconds}:f>`;
}

function limitDisplayText(value: string): string {
  if (value.length <= DISPLAY_ITEM_LIMIT) return value;
  return `${value.slice(0, DISPLAY_ITEM_LIMIT - 1)}…`;
}

function limitOptionText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function cleanItemText(value: string): string | undefined {
  const cleaned = value
    .replace(/\s+/gu, " ")
    .replace(/^["“”'‘’]+/u, "")
    .replace(/["“”'‘’]+$/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (cleaned.length < 2) return undefined;
  return sentenceCase(cleaned);
}

function sentenceCase(value: string): string {
  const first = value[0] ?? "";
  const rest = value.slice(1);
  return `${first.toLocaleUpperCase()}${rest}`;
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

function listForChannel(
  guildState: GuildTodoState,
  channelId: string,
): ChannelTodoState | undefined {
  const channelList = guildState.lists?.[channelId];
  if (channelList) return channelList;
  if (guildState.channelId === channelId) {
    return {
      channelId: guildState.channelId,
      messageId: guildState.messageId,
      items: guildState.items,
    };
  }
  return undefined;
}

function updateGuildList(
  guildState: GuildTodoState,
  list: ChannelTodoState,
): GuildTodoState {
  if (
    guildState.channelId === list.channelId &&
    !guildState.lists?.[list.channelId]
  ) {
    return {
      ...guildState,
      channelId: list.channelId,
      messageId: list.messageId,
      items: list.items,
    };
  }
  return {
    ...guildState,
    lists: {
      ...(guildState.lists ?? {}),
      [list.channelId]: list,
    },
  };
}

function emptyGuildState(): GuildTodoState {
  return { items: [] };
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

function currentDiscordReminderUser(): ReminderUser | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const author = parsed["author"];
  if (!isRecord(author)) return undefined;
  const discordUserId = stringField(author, "discordUserId");
  if (!discordUserId) return undefined;
  return {
    discordUserId,
    ...(stringField(author, "username")
      ? { username: stringField(author, "username") }
      : {}),
    ...(stringField(author, "displayName")
      ? { displayName: stringField(author, "displayName") }
      : {}),
    ...(stringField(author, "identityId")
      ? { identityId: stringField(author, "identityId") }
      : {}),
  };
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
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase();
  return normalizeReminderId(`todo_${stamp}_${randomUUID().slice(0, 8)}`);
}

function nullish<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
