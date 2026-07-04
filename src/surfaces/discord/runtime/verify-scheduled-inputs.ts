import assert from "node:assert/strict";

import {
  CreateEventInputSchema,
  EventRuntimeIdInputSchema,
  ListScheduledEventsInputSchema,
} from "@/surfaces/discord/runtime/event-inputs";
import {
  CreateReminderInputSchema,
  ListHumanRemindersInputSchema,
  OptionalReminderUserInputSchema,
  ReminderRuntimeIdInputSchema,
  ReminderUserInputSchema,
  SnoozeReminderInputSchema,
} from "@/surfaces/discord/runtime/reminder-inputs";

const CHANNEL = "123456789012345678";
const USER = "111111111111111111";
const ISO = "2026-07-04T12:30:00.000Z";

// Scheduled event helpers parse text, ids, targets, and timing choices before
// writing event files. Timestamps are normalized to ISO strings, cron/timezone
// values are parsed at the helper boundary, and mutually exclusive target/time
// fields are rejected instead of being silently ignored downstream.
assert.equal(EventRuntimeIdInputSchema.parse(" event-a "), "event-a");
assert.throws(() => EventRuntimeIdInputSchema.parse("   "));
assert.deepEqual(
  CreateEventInputSchema.parse({
    text: " hourly check ",
    schedule: " 0 * * * * ",
    timezone: " America/Los_Angeles ",
    channelId: `<#${CHANNEL}>`,
  }),
  {
    text: "hourly check",
    schedule: "0 * * * *",
    timezone: "America/Los_Angeles",
    channelId: `<#${CHANNEL}>`,
  },
);
assert.deepEqual(
  CreateEventInputSchema.parse({
    text: "one-shot",
    at: "2026-07-04T05:30:00-07:00",
  }),
  { text: "one-shot", at: ISO },
);
assert.throws(() => CreateEventInputSchema.parse({ text: "   " }));
assert.throws(() => CreateEventInputSchema.parse({ text: "x", at: "now" }));
assert.throws(() =>
  CreateEventInputSchema.parse({ text: "x", schedule: "not a cron" }),
);
assert.throws(() =>
  CreateEventInputSchema.parse({
    text: "x",
    schedule: "0 * * * *",
    timezone: "Mars/OlympusMons",
  }),
);
assert.throws(() =>
  CreateEventInputSchema.parse({ text: "x", at: ISO, schedule: "* * * * *" }),
);
assert.throws(() =>
  CreateEventInputSchema.parse({
    text: "x",
    threadId: CHANNEL,
    channelId: CHANNEL,
  }),
);
assert.throws(() =>
  CreateEventInputSchema.parse({ text: "x", type: "periodic" }),
);
assert.deepEqual(
  ListScheduledEventsInputSchema.parse({
    scope: "current_channel",
    channelId: CHANNEL,
  }),
  { scope: "current_channel", channelId: CHANNEL },
);
assert.throws(() => ListScheduledEventsInputSchema.parse({ scope: "nearby" }));

// Reminder helpers use the same explicit Discord target validation, plus
// positive integer knobs for follow-up/snooze intervals and numeric Discord
// users when a generated helper call supplies actor or audience ids.
assert.equal(ReminderRuntimeIdInputSchema.parse(" reminder-a "), "reminder-a");
assert.throws(() => ReminderRuntimeIdInputSchema.parse("   "));
assert.deepEqual(
  CreateReminderInputSchema.parse({
    text: " water the uncanny geranium ",
    at: "2026-07-04T05:30:00-07:00",
    followupIntervalMinutes: 90,
    recurrence: { schedule: "0 9 * * *", timezone: "America/Los_Angeles" },
    audienceUserIds: [USER],
    createdBy: { discordUserId: USER, username: " jess " },
    threadId: CHANNEL,
  }),
  {
    text: "water the uncanny geranium",
    at: ISO,
    followupIntervalMinutes: 90,
    recurrence: { schedule: "0 9 * * *", timezone: "America/Los_Angeles" },
    audienceUserIds: [USER],
    createdBy: { discordUserId: USER, username: "jess" },
    threadId: CHANNEL,
  },
);
assert.throws(() =>
  CreateReminderInputSchema.parse({ text: "x", followupIntervalMinutes: 0 }),
);
assert.throws(() =>
  CreateReminderInputSchema.parse({ text: "x", audienceUserIds: ["not-id"] }),
);
assert.throws(() =>
  CreateReminderInputSchema.parse({
    text: "x",
    recurrence: { schedule: "nope", timezone: "UTC" },
  }),
);
assert.deepEqual(ListHumanRemindersInputSchema.parse({ scope: "all" }), {
  scope: "all",
});
assert.deepEqual(
  ReminderUserInputSchema.parse({
    discordUserId: USER,
    displayName: " Jess ",
  }),
  { discordUserId: USER, displayName: "Jess" },
);
assert.throws(() => ReminderUserInputSchema.parse({ discordUserId: "not-id" }));
assert.equal(OptionalReminderUserInputSchema.parse(undefined), undefined);
assert.throws(() => OptionalReminderUserInputSchema.parse(null));
assert.throws(() => OptionalReminderUserInputSchema.parse(false));
assert.deepEqual(SnoozeReminderInputSchema.parse({ minutes: 60 }), {
  minutes: 60,
});
assert.deepEqual(
  SnoozeReminderInputSchema.parse({ until: "2026-07-04T05:30:00-07:00" }),
  { until: ISO },
);
assert.throws(() => SnoozeReminderInputSchema.parse({ until: "tomorrow" }));
assert.throws(() => SnoozeReminderInputSchema.parse({}));
assert.throws(() =>
  SnoozeReminderInputSchema.parse({ until: ISO, minutes: 60 }),
);

console.log("discord scheduled runtime input verification passed");
