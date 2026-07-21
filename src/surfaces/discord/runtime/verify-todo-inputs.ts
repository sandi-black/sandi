import assert from "node:assert/strict";
import "@/surfaces/discord/shared/verify-todo-core";

import {
  addItem,
  completeItem,
  configureList,
  listItems,
  removeItem,
  updateItem,
} from "@/surfaces/discord/runtime/todo";
import {
  AddTodoItemInputSchema,
  CompleteTodoItemInputSchema,
  ConfigureTodoListInputSchema,
  ListTodoItemsInputSchema,
  RemoveTodoItemInputSchema,
  UpdateTodoItemInputSchema,
} from "@/surfaces/discord/runtime/todo-inputs";

const CHANNEL = "123456789012345678";
const USER = "111111111111111111";
const ISO = "2026-07-04T12:30:00.000Z";

assert.deepEqual(ListTodoItemsInputSchema.parse({ channel: `<#${CHANNEL}>` }), {
  channel: CHANNEL,
});
assert.throws(() => ListTodoItemsInputSchema.parse({ channel: "general" }));

assert.deepEqual(
  ConfigureTodoListInputSchema.parse({
    channel: `<#${CHANNEL}>`,
    title: " Household tasks ",
    instructions: null,
    completionMode: "buttons",
    displayMode: "grouped-reminders",
  }),
  {
    channel: CHANNEL,
    title: "Household tasks",
    instructions: null,
    completionMode: "buttons",
    displayMode: "grouped-reminders",
  },
);
assert.throws(() => ConfigureTodoListInputSchema.parse({}));
assert.throws(() =>
  ConfigureTodoListInputSchema.parse({ completionMode: "checkboxes" }),
);

assert.deepEqual(
  AddTodoItemInputSchema.parse({
    text: " buy milk. ",
    channel: `<#${CHANNEL}>`,
    authorName: " Grace Hopper ",
    sourceUrl: " https://example.com/list ",
    reason: " breakfast ",
    reminderAt: "2026-07-04T05:30:00-07:00",
    recurrence: { schedule: "0 9 * * *", timezone: "America/Los_Angeles" },
    recurrenceSummary: " every morning ",
    audienceUserIds: [USER],
    createdBy: { discordUserId: USER, displayName: " Grace " },
  }),
  {
    text: "Buy milk",
    channel: CHANNEL,
    authorName: "Grace Hopper",
    sourceUrl: "https://example.com/list",
    reason: "breakfast",
    reminderAt: ISO,
    recurrence: { schedule: "0 9 * * *", timezone: "America/Los_Angeles" },
    recurrenceSummary: "every morning",
    audienceUserIds: [USER],
    createdBy: { discordUserId: USER, displayName: "Grace" },
  },
);
assert.throws(() => AddTodoItemInputSchema.parse({ text: "   " }));
assert.throws(() =>
  AddTodoItemInputSchema.parse({
    text: "buy milk",
    recurrence: { schedule: "not cron", timezone: "UTC" },
  }),
);
assert.throws(() =>
  AddTodoItemInputSchema.parse({
    text: "buy milk",
    createdBy: { discordUserId: "not-a-snowflake" },
  }),
);
assert.throws(() =>
  AddTodoItemInputSchema.parse({
    text: "buy milk",
    recurrenceSummary: "daily",
  }),
);

const removalUpdate = UpdateTodoItemInputSchema.parse({
  itemId: " item-a ",
  reason: null,
  reminderAt: null,
  recurrence: null,
  recurrenceSummary: null,
});
assert.equal(removalUpdate.itemId, "item-a");
assert.equal(removalUpdate.reason, null);
assert.equal(removalUpdate.reminderAt, null);
assert.equal(removalUpdate.recurrence, null);
assert.equal(removalUpdate.recurrenceSummary, null);
assert(
  !Object.hasOwn(
    UpdateTodoItemInputSchema.parse({ itemId: "item-a" }),
    "reason",
  ),
);
assert.throws(() => UpdateTodoItemInputSchema.parse({ text: "new text" }));
assert.throws(() =>
  UpdateTodoItemInputSchema.parse({ itemId: "item-a", matchText: "milk" }),
);
assert.throws(() =>
  UpdateTodoItemInputSchema.parse({
    itemId: "item-a",
    recurrence: null,
    recurrenceSummary: "daily",
  }),
);

assert.deepEqual(
  CompleteTodoItemInputSchema.parse({
    matchText: " milk ",
    doneBy: { discordUserId: USER },
  }),
  { matchText: "milk", doneBy: { discordUserId: USER } },
);
assert.throws(() => CompleteTodoItemInputSchema.parse({ matchText: " " }));
assert.throws(() =>
  CompleteTodoItemInputSchema.parse({
    itemId: "item-a",
    doneBy: { discordUserId: "invalid" },
  }),
);

assert.deepEqual(RemoveTodoItemInputSchema.parse({ itemId: " item-a " }), {
  itemId: "item-a",
});
assert.throws(() => RemoveTodoItemInputSchema.parse({}));
assert.throws(() =>
  RemoveTodoItemInputSchema.parse({ itemId: "item-a", matchText: "milk" }),
);

await assert.rejects(listItems({ channel: "general" }), /channel must be/u);
await assert.rejects(addItem({ text: " " }), /todo text must/u);
await assert.rejects(configureList({}), /provide at least one/u);
await assert.rejects(updateItem({}), /provide exactly one/u);
await assert.rejects(completeItem({}), /provide exactly one/u);
await assert.rejects(
  removeItem({ itemId: "item-a", matchText: "milk" }),
  /provide exactly one/u,
);

console.log("discord todo runtime input verification passed");
