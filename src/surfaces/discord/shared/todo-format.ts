// Pure schema and formatting logic for the interactive Discord todo list,
// shared between the live Discord.js bot (bot/todo-list.ts, which also
// handles button/select interactions) and the sandi_js_run runtime helper
// (runtime/todo.ts). Dependency-free aside from zod and shared/format.ts:
// relative imports only, since bot/ and runtime/ both stay free to reach this
// without the tsconfig path alias.

import { formatDiscordTimestamp } from "./format";
import { z } from "zod/v4";

export const DISCORD_MESSAGE_LIMIT = 2_000;
export const DISPLAY_ITEM_LIMIT = 160;
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export const TodoItemSchema = z.object({
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

export type TodoItem = z.infer<typeof TodoItemSchema>;

export const ChannelTodoStateSchema = z.object({
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

export type ChannelTodoState = z.infer<typeof ChannelTodoStateSchema>;

export const GuildTodoStateSchema = z.object({
  channelId: z.string().optional(),
  messageId: z.string().optional(),
  items: z.array(TodoItemSchema),
  lists: z.record(z.string(), ChannelTodoStateSchema).optional(),
});

export type GuildTodoState = z.infer<typeof GuildTodoStateSchema>;

// A resolved location for a channel's todo list: either a "lists" map entry
// (the normal case) or the original single legacy list still stored directly
// on the guild state (pre-multi-channel data). Threading the "kind" through a
// find/update pair keeps a legacy-slot channel writing back to that same slot
// instead of forking into a second list the first time it's touched.
export type TodoListRef =
  | { kind: "channel"; channelId: string; list: ChannelTodoState }
  | { kind: "legacy"; list: ChannelTodoState };

export function emptyGuildState(): GuildTodoState {
  return { items: [] };
}

export function legacyList(guildState: GuildTodoState): ChannelTodoState {
  return {
    channelId: guildState.channelId ?? "",
    messageId: guildState.messageId,
    items: guildState.items,
  };
}

export function listForChannel(
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

export function updateGuildList(
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

export function cleanItemText(value: string): string | undefined {
  // Trim before stripping quotes: the strip patterns are anchored, so
  // whitespace outside a quoted phrase would otherwise shield the quotes.
  const cleaned = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["“”'‘’]+/u, "")
    .replace(/["“”'‘’]+$/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (cleaned.length < 2) return undefined;
  return sentenceCase(cleaned);
}

// Uppercases the first Unicode code point rather than the first UTF-16 code
// unit, so a todo item starting with an astral character (an emoji, for
// example) is not split mid-surrogate-pair.
export function sentenceCase(value: string): string {
  const [first = "", ...rest] = value;
  return `${first.toLocaleUpperCase()}${rest.join("")}`;
}

export function limitDisplayText(value: string): string {
  if (value.length <= DISPLAY_ITEM_LIMIT) return value;
  return `${value.slice(0, DISPLAY_ITEM_LIMIT - 1)}…`;
}

export function reminderDateAndTime(
  iso: string | undefined,
): string | undefined {
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

export function formatTodoLine(item: TodoItem): string {
  const source = item.sourceUrl ? ` ([source](${item.sourceUrl}))` : "";
  const reminder = item.reminderAt
    ? ` — reminds ${formatDiscordTimestamp(item.reminderAt)}`
    : "";
  const repeat = item.reminderRepeat ? ` — repeats ${item.reminderRepeat}` : "";
  return `- ${limitDisplayText(item.text)} — ${item.authorName}${reminder}${repeat}${source}`;
}

export function formatTodoList(list: ChannelTodoState): string {
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

export function formatGroupedReminderList(list: ChannelTodoState): string {
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
