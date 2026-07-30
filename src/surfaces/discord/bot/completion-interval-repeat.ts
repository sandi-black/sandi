import type { ReminderRecurrence } from "@/surfaces/discord/reminders/schemas";

type RepeatTime = {
  hour: number;
  minute: number;
};

export function parseCompletionIntervalRepeat(
  value: string,
  time: RepeatTime,
  timezone: string,
): { recurrence: ReminderRecurrence; summary: string } | undefined {
  const match = /\bevery\s+(\d+)\s+days?\b/u.exec(value);
  const rawDays = match?.[1];
  if (!rawDays) return undefined;
  const everyDays = Number(rawDays);
  if (!Number.isSafeInteger(everyDays) || everyDays <= 0) return undefined;
  return {
    recurrence: {
      kind: "completion-interval",
      everyDays,
      localTime: `${time.hour.toString().padStart(2, "0")}:${time.minute.toString().padStart(2, "0")}`,
      timezone,
    },
    summary: `every ${everyDays} ${everyDays === 1 ? "day" : "days"} from completion at ${formatRepeatTime(time)}`,
  };
}

function formatRepeatTime(time: RepeatTime): string {
  const hour12 = time.hour % 12 || 12;
  const minute = time.minute.toString().padStart(2, "0");
  const suffix = time.hour < 12 ? "AM" : "PM";
  return `${hour12}:${minute} ${suffix}`;
}
