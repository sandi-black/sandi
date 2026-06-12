import { Cron } from "croner";

import type { Reminder, ReminderRecurrence } from "./schemas";

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
