import { join } from "node:path";

import { REST, Routes } from "discord.js";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";
import {
  currentDiscordReminderUser,
  readDiscordPlatformContext,
} from "@/surfaces/discord/runtime/context";
import { resolveGuildId } from "@/surfaces/discord/runtime/guild";
import {
  type AddTodoItemInput,
  AddTodoItemInputSchema,
  type CompleteTodoItemInput,
  CompleteTodoItemInputSchema,
  type ListTodoItemsInput,
  ListTodoItemsInputSchema,
  type RemoveTodoItemInput,
  RemoveTodoItemInputSchema,
  type UpdateTodoItemInput,
  UpdateTodoItemInputSchema,
} from "@/surfaces/discord/runtime/todo-inputs";
import type { DiscordContext } from "@/surfaces/discord/shared/rest";
import {
  MAX_TODO_ITEMS,
  TodoApplication,
  type TodoItemSelector,
  type TodoListState,
  TodoListStateSchema,
} from "@/surfaces/discord/shared/todo-core";
import {
  type ChannelTodoState,
  formatTodoList,
  type TodoItem,
} from "@/surfaces/discord/shared/todo-format";

const TODO_STATE_PATH = "todo-list/state.json";
const DiscordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  content: z.string(),
});

type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

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

export type {
  AddTodoItemInput,
  CompleteTodoItemInput,
  ListTodoItemsInput,
  RemoveTodoItemInput,
  UpdateTodoItemInput,
};

export type TodoListResult = {
  channelId: string;
  messageId?: string;
  items: TodoItemSummary[];
};

export async function listItems(
  input: ListTodoItemsInput = {},
): Promise<TodoListResult> {
  const parsed = ListTodoItemsInputSchema.parse(input);
  const { guildId, channelId } = currentTodoTarget(parsed.channel);
  const list = await application().list(guildId, { channelId });
  return todoListResult(list ?? emptyChannelList(channelId));
}

export async function addItem(
  input: AddTodoItemInput,
): Promise<TodoListResult> {
  const parsed = AddTodoItemInputSchema.parse(input);
  const { guildId, channelId } = currentTodoTarget(parsed.channel);
  const result = await application().add({
    guildId,
    list: { channelId },
    text: parsed.text,
    authorName: parsed.authorName ?? "Sandi",
    ...(parsed.sourceUrl !== undefined ? { sourceUrl: parsed.sourceUrl } : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    ...(parsed.reminderAt !== undefined
      ? { reminderAt: parsed.reminderAt }
      : {}),
    ...(parsed.recurrence !== undefined
      ? { recurrence: parsed.recurrence }
      : {}),
    ...(parsed.recurrenceSummary !== undefined
      ? { recurrenceSummary: parsed.recurrenceSummary }
      : {}),
    ...(parsed.audienceUserIds !== undefined
      ? { audienceUserIds: parsed.audienceUserIds }
      : {}),
    createdBy: parsed.createdBy ?? currentDiscordReminderUser(),
  });
  return todoListResult(result.list);
}

export async function updateItem(
  input: UpdateTodoItemInput,
): Promise<TodoListResult> {
  const parsed = UpdateTodoItemInputSchema.parse(input);
  const { guildId, channelId } = currentTodoTarget(parsed.channel);
  const result = await application().update({
    guildId,
    list: { channelId },
    item: todoSelector(parsed),
    ...(parsed.text !== undefined ? { text: parsed.text } : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    ...(parsed.reminderAt !== undefined
      ? { reminderAt: parsed.reminderAt }
      : {}),
    ...(parsed.recurrence !== undefined
      ? { recurrence: parsed.recurrence }
      : {}),
    ...(parsed.recurrenceSummary !== undefined
      ? { recurrenceSummary: parsed.recurrenceSummary }
      : {}),
    ...(parsed.audienceUserIds !== undefined
      ? { audienceUserIds: parsed.audienceUserIds }
      : {}),
    ...(parsed.updatedBy !== undefined ? { updatedBy: parsed.updatedBy } : {}),
  });
  return todoListResult(result.list);
}

export async function completeItem(
  input: CompleteTodoItemInput,
): Promise<TodoListResult> {
  const parsed = CompleteTodoItemInputSchema.parse(input);
  const { guildId, channelId } = currentTodoTarget(parsed.channel);
  const result = await application().complete({
    guildId,
    list: { channelId },
    item: todoSelector(parsed),
    ...(parsed.doneBy !== undefined ? { doneBy: parsed.doneBy } : {}),
  });
  return todoListResult(result.list);
}

export async function removeItem(
  input: RemoveTodoItemInput,
): Promise<TodoListResult> {
  const parsed = RemoveTodoItemInputSchema.parse(input);
  const { guildId, channelId } = currentTodoTarget(parsed.channel);
  const result = await application().remove({
    guildId,
    list: { channelId },
    item: todoSelector(parsed),
  });
  return todoListResult(result.list);
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
    ? channelRef
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
  return readDiscordPlatformContext();
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

function application(): TodoApplication {
  return new TodoApplication({
    store: store(),
    remindersRoot: remindersRoot(),
    renderList: upsertRenderedList,
    currentUser: currentDiscordReminderUser,
  });
}

function todoSelector(input: {
  itemId?: string | undefined;
  matchText?: string | undefined;
}): TodoItemSelector {
  if (input.itemId) return { itemId: input.itemId };
  if (input.matchText) return { matchText: input.matchText };
  throw new Error("Provide itemId or matchText.");
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
