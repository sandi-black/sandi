import assert from "node:assert/strict";

import { withTempDir } from "@/lib/verification/harness";
import { parseCompletionIntervalRepeat } from "@/surfaces/discord/bot/completion-interval-repeat";
import {
  completedReminder,
  nextRecurrenceRun,
} from "@/surfaces/discord/reminders/recurrence";
import type {
  Reminder,
  ReminderRecurrence,
} from "@/surfaces/discord/reminders/schemas";
import { writeReminder } from "@/surfaces/discord/reminders/store";
import { updateReminderRecurrence } from "@/surfaces/discord/runtime/reminders";

const PACIFIC_INTERVAL = {
  kind: "completion-interval",
  everyDays: 7,
  localTime: "18:00",
  timezone: "America/Los_Angeles",
} satisfies ReminderRecurrence;

assert.equal(
  nextRecurrenceRun(
    PACIFIC_INTERVAL,
    new Date("2026-07-26T01:00:00.000Z"),
  )?.toISOString(),
  "2026-08-02T01:00:00.000Z",
  "on-time completion should schedule the same local time seven days later",
);
assert.equal(
  nextRecurrenceRun(
    PACIFIC_INTERVAL,
    new Date("2026-07-25T09:25:00.000Z"),
  )?.toISOString(),
  "2026-08-02T01:00:00.000Z",
  "late completion should move the interval from the local completion date",
);
assert.equal(
  nextRecurrenceRun(
    PACIFIC_INTERVAL,
    new Date("2026-07-25T01:00:00.000Z"),
  )?.toISOString(),
  "2026-08-01T01:00:00.000Z",
  "the completion timezone should determine the calendar day",
);
assert.equal(
  nextRecurrenceRun(
    PACIFIC_INTERVAL,
    new Date("2026-10-31T09:00:00.000Z"),
  )?.toISOString(),
  "2026-11-08T02:00:00.000Z",
  "the original wall-clock time should survive the fall DST transition",
);
assert.equal(
  nextRecurrenceRun(
    PACIFIC_INTERVAL,
    new Date("2027-03-07T10:00:00.000Z"),
  )?.toISOString(),
  "2027-03-15T01:00:00.000Z",
  "the original wall-clock time should survive the spring DST transition",
);

const calendar = {
  kind: "calendar",
  schedule: "0 18 * * WED",
  timezone: "America/Los_Angeles",
} satisfies ReminderRecurrence;
assert.equal(
  nextRecurrenceRun(
    calendar,
    new Date("2026-07-25T09:25:00.000Z"),
  )?.toISOString(),
  "2026-07-30T01:00:00.000Z",
  "calendar recurrence should remain anchored to its cron schedule",
);

const completed = completedReminder(
  reminder(PACIFIC_INTERVAL),
  { discordUserId: "ada" },
  new Date("2026-07-25T09:25:00.000Z"),
);
assert.equal(completed.status, "active");
assert.equal(completed.nextFireAt, "2026-08-02T01:00:00.000Z");
assert.equal(completed.doneAt, "2026-07-25T09:25:00.000Z");
assert.deepEqual(completed.messageRefs, []);
assert.equal(completed.fireCount, 0);

assert.deepEqual(
  parseCompletionIntervalRepeat(
    "every 7 days at 6pm",
    { hour: 18, minute: 0 },
    "America/Los_Angeles",
  ),
  {
    recurrence: PACIFIC_INTERVAL,
    summary: "every 7 days from completion at 6:00 PM",
  },
);
assert.equal(
  parseCompletionIntervalRepeat(
    "every Wednesday at 6pm",
    { hour: 18, minute: 0 },
    "America/Los_Angeles",
  ),
  undefined,
);

const previousRemindersRoot = process.env["SANDI_REMINDERS_ROOT"];
try {
  await withTempDir("sandi-completion-interval-", async (root) => {
    process.env["SANDI_REMINDERS_ROOT"] = root;
    const existing = reminder(calendar);
    await writeReminder(root, "feed-kanti", existing);
    const updated = await updateReminderRecurrence("feed-kanti", {
      recurrence: PACIFIC_INTERVAL,
    });
    assert.equal(updated.nextFireAt, existing.nextFireAt);
    assert.equal(updated.followupIntervalMinutes, 60);
    assert.equal(updated.fireCount, 3);
    assert.deepEqual(updated.messageRefs, existing.messageRefs);
    assert.deepEqual(updated.recurrence, PACIFIC_INTERVAL);
  });
} finally {
  if (previousRemindersRoot === undefined) {
    delete process.env["SANDI_REMINDERS_ROOT"];
  } else {
    process.env["SANDI_REMINDERS_ROOT"] = previousRemindersRoot;
  }
}

function reminder(recurrence: ReminderRecurrence): Reminder {
  return {
    target: { kind: "channel", channelId: "grace" },
    text: "Feed Kanti",
    createdAt: "2026-07-18T01:00:00.000Z",
    audienceUserIds: [],
    status: "active",
    nextFireAt: "2026-07-24T01:00:00.000Z",
    recurrence,
    followupIntervalMinutes: 60,
    fireCount: 3,
    messageRefs: [{ channelId: "grace", messageId: "hopper" }],
  };
}

console.log("completion-based reminder recurrence verification passed");
