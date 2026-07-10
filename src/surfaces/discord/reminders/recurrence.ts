import { Cron } from "croner";

import type { Reminder, ReminderRecurrence, ReminderUser } from "./schemas";

// Marks a reminder done: if it recurs, rolls it forward to the next run and
// resets its per-cycle fire bookkeeping; otherwise marks it done outright.
// Shared because every reminder-completing surface (the live bot's reminder
// buttons, the bot's todo-list "complete" flow, and the sandi_js_run runtime
// helpers for both) needs the exact same rollover behavior.
export function completedReminder(
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

export function nextReminderRecurrenceRun(
  reminder: Reminder,
  after: Date = new Date(),
): Date | undefined {
  if (!reminder.recurrence) return undefined;
  return nextRecurrenceRun(reminder.recurrence, after);
}

export function nextRecurrenceRun(
  recurrence: ReminderRecurrence,
  after: Date = new Date(),
): Date | undefined {
  const next = new Cron(recurrence.schedule, {
    paused: true,
    timezone: recurrence.timezone,
  }).nextRun(after);
  if (!next || !Number.isFinite(next.getTime())) return undefined;
  return next;
}

export function validateReminderRecurrence(
  recurrence: ReminderRecurrence,
): void {
  const next = nextRecurrenceRun(recurrence);
  if (!next) {
    throw new Error(
      `Recurring reminder schedule has no future runs: ${recurrence.schedule} ${recurrence.timezone}`,
    );
  }
}
