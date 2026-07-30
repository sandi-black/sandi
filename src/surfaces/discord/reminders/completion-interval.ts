import type { ReminderCompletionIntervalRecurrence } from "./schemas";

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function nextCompletionIntervalRun(
  recurrence: ReminderCompletionIntervalRecurrence,
  completedAt: Date,
): Date {
  const completed = localDateTime(completedAt, recurrence.timezone);
  const targetDate = addCalendarDays(completed, recurrence.everyDays);
  const time = parseLocalTime(recurrence.localTime);
  return localDateTimeToDate(
    {
      ...targetDate,
      hour: time.hour,
      minute: time.minute,
    },
    recurrence.timezone,
  );
}

function localDateTime(date: Date, timezone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let hour: number | undefined;
  let minute: number | undefined;
  for (const part of formatter.formatToParts(date)) {
    const value = Number(part.value);
    if (part.type === "year") year = value;
    if (part.type === "month") month = value;
    if (part.type === "day") day = value;
    if (part.type === "hour") hour = value;
    if (part.type === "minute") minute = value;
  }
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new Error(`Could not resolve local date and time in ${timezone}.`);
  }
  return { year, month, day, hour, minute };
}

function addCalendarDays(
  date: Pick<LocalDateTime, "year" | "month" | "day">,
  days: number,
): Pick<LocalDateTime, "year" | "month" | "day"> {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = localTime.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`Invalid reminder local time: ${localTime}`);
  }
  return { hour, minute };
}

function localDateTimeToDate(desired: LocalDateTime, timezone: string): Date {
  const desiredWallClock = wallClockTimestamp(desired);
  let candidate = desiredWallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateTime(new Date(candidate), timezone);
    const correction = desiredWallClock - wallClockTimestamp(actual);
    if (correction === 0) return new Date(candidate);
    candidate += correction;
  }
  throw new Error(
    `Local reminder time ${formatLocalDateTime(desired)} does not exist in ${timezone}.`,
  );
}

function wallClockTimestamp(value: LocalDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
  );
}

function formatLocalDateTime(value: LocalDateTime): string {
  const month = value.month.toString().padStart(2, "0");
  const day = value.day.toString().padStart(2, "0");
  const hour = value.hour.toString().padStart(2, "0");
  const minute = value.minute.toString().padStart(2, "0");
  return `${value.year}-${month}-${day} ${hour}:${minute}`;
}
