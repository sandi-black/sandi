import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileStore } from "@/lib/state/file-store";
import { readReminder } from "@/surfaces/discord/reminders/store";
import {
  TodoApplication,
  TodoListFullError,
  type TodoListSelector,
  type TodoListState,
  TodoListStateSchema,
} from "@/surfaces/discord/shared/todo-core";
import type { ChannelTodoState } from "@/surfaces/discord/shared/todo-format";

const GUILD_ID = "guild-ada";
const CHANNEL_ID = "channel-grace";
const MESSAGE_ID = "message-anna";
const CUSTOM_LIST: ChannelTodoState = {
  channelId: CHANNEL_ID,
  targetKind: "thread",
  title: "Launch checklist",
  instructions: "Complete these in order.",
  emptyText: "Launch complete.",
  completionMode: "buttons",
  displayMode: "grouped-reminders",
  messageId: MESSAGE_ID,
  items: [],
};

for (const selector of [
  { channelId: CHANNEL_ID },
  { messageId: MESSAGE_ID },
] satisfies TodoListSelector[]) {
  await verifyMutationScenario(selector);
}

async function verifyMutationScenario(
  selector: TodoListSelector,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sandi-todo-core-"));
  const remindersRoot = join(root, "reminders");
  const store = new JsonFileStore<TodoListState>(
    join(root, "todo.json"),
    TodoListStateSchema,
  );
  let reminderSequence = 0;
  let renderCount = 0;
  const application = new TodoApplication({
    store,
    remindersRoot,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    newReminderId: () => `reminder-${++reminderSequence}`,
    renderList: async (list) => {
      renderCount += 1;
      return list;
    },
  });

  try {
    await store.write({
      guilds: {
        [GUILD_ID]: { items: [], lists: { [CHANNEL_ID]: CUSTOM_LIST } },
      },
    });

    const oneTime = await application.add({
      guildId: GUILD_ID,
      list: selector,
      id: "one-time",
      text: "Publish release notes",
      authorName: "Grace Hopper",
      reason: "Keep operators informed",
      reminderAt: "2026-07-11T09:00:00.000Z",
    });
    assertCustomFields(oneTime.list);
    assert.equal(oneTime.item.reminderId, "reminder-1");
    assert.deepEqual((await readReminder(remindersRoot, "reminder-1")).target, {
      kind: "thread",
      threadId: CHANNEL_ID,
    });

    const updated = await application.update({
      guildId: GUILD_ID,
      list: selector,
      item: { itemId: "one-time" },
      text: "Publish final release notes",
      reason: null,
    });
    assertCustomFields(updated.list);
    assert.equal(updated.item.text, "Publish final release notes");
    assert.equal(updated.item.reason, undefined);

    const completed = await application.complete({
      guildId: GUILD_ID,
      list: selector,
      item: { itemId: "one-time" },
      doneBy: { discordUserId: "user-ada" },
    });
    assertCustomFields(completed.list);
    assert.equal(completed.list.items.length, 0);
    assert.equal(
      (await readReminder(remindersRoot, "reminder-1")).status,
      "done",
    );

    const recurring = await application.add({
      guildId: GUILD_ID,
      list: selector,
      id: "recurring",
      text: "Review deployment health",
      authorName: "Ada Lovelace",
      reminderAt: "2020-01-01T09:00:00.000Z",
      recurrence: { schedule: "0 9 * * *", timezone: "UTC" },
      recurrenceSummary: "daily",
    });
    const firstFireAt = recurring.item.reminderAt;
    const rolled = await application.complete({
      guildId: GUILD_ID,
      list: selector,
      item: { matchText: "deployment health" },
    });
    assertCustomFields(rolled.list);
    assert.equal(rolled.list.items.length, 1);
    assert.equal(rolled.item.reminderRepeat, "daily");
    assert.notEqual(rolled.item.reminderAt, firstFireAt);
    assert.equal(
      (await readReminder(remindersRoot, "reminder-2")).status,
      "active",
    );

    const withoutReminder = await application.update({
      guildId: GUILD_ID,
      list: selector,
      item: { itemId: "recurring" },
      reminderAt: null,
      recurrence: null,
      recurrenceSummary: null,
    });
    assert.equal(withoutReminder.item.reminderId, undefined);
    await assert.rejects(readReminder(remindersRoot, "reminder-2"));

    await application.add({
      guildId: GUILD_ID,
      list: selector,
      id: "remove-me",
      text: "Remove obsolete flag",
      authorName: "Anna Winlock",
      reminderAt: "2026-07-12T09:00:00.000Z",
    });
    const removed = await application.remove({
      guildId: GUILD_ID,
      list: selector,
      item: { itemId: "remove-me" },
    });
    assertCustomFields(removed.list);
    await assert.rejects(readReminder(remindersRoot, "reminder-3"));

    await application.add({
      guildId: GUILD_ID,
      list: selector,
      id: "delivered-reminder",
      text: "Archive delivered reminder",
      authorName: "Margaret Hamilton",
      reminderAt: "2026-07-13T09:00:00.000Z",
    });
    assert.equal(
      await application.removeCompletedOneTimeReminder("reminder-4"),
      true,
    );
    assert.equal(
      (await application.list(GUILD_ID, selector))?.items.some(
        (item) => item.id === "delivered-reminder",
      ),
      false,
    );
    assert.equal(renderCount, 10);

    await store.write({
      guilds: {
        [GUILD_ID]: {
          items: [],
          lists: {
            [CHANNEL_ID]: {
              ...CUSTOM_LIST,
              items: Array.from({ length: 10 }, (_, index) => ({
                id: `full-${index}`,
                text: `Release task ${index}`,
                authorName: "Radia Perlman",
                createdAt: "2026-07-10T12:00:00.000Z",
              })),
            },
          },
        },
      },
    });
    await assert.rejects(
      application.add({
        guildId: GUILD_ID,
        list: selector,
        text: "Overflow task",
        authorName: "Evelyn Boyd Granville",
      }),
      TodoListFullError,
    );
    await assert.rejects(
      application.remove({
        guildId: GUILD_ID,
        list: selector,
        item: { matchText: "Release task" },
      }),
      /Multiple todo items matched/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertCustomFields(list: ChannelTodoState): void {
  assert.deepEqual(
    {
      targetKind: list.targetKind,
      title: list.title,
      instructions: list.instructions,
      emptyText: list.emptyText,
      completionMode: list.completionMode,
      displayMode: list.displayMode,
      messageId: list.messageId,
    },
    {
      targetKind: CUSTOM_LIST.targetKind,
      title: CUSTOM_LIST.title,
      instructions: CUSTOM_LIST.instructions,
      emptyText: CUSTOM_LIST.emptyText,
      completionMode: CUSTOM_LIST.completionMode,
      displayMode: CUSTOM_LIST.displayMode,
      messageId: CUSTOM_LIST.messageId,
    },
  );
}

console.log("discord todo core verification passed");
