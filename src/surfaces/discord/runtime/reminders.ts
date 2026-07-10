import type { z } from "zod/v4";
import { generateTimestampId } from "@/lib/ids";
import { isRecord } from "@/lib/type-guards";
import {
  completedReminder,
  nextRecurrenceRun,
  validateReminderRecurrence,
} from "@/surfaces/discord/reminders/recurrence";
import type {
  Reminder,
  ReminderRecurrence,
  ReminderTarget,
  ReminderUser,
} from "@/surfaces/discord/reminders/schemas";
import {
  listReminders,
  normalizeReminderId,
  readReminder,
  writeReminder,
} from "@/surfaces/discord/reminders/store";
import {
  currentDiscordReminderUser,
  readDiscordPlatformContext,
} from "@/surfaces/discord/runtime/context";
import {
  CreateReminderInputSchema,
  ListHumanRemindersInputSchema,
  OptionalReminderUserInputSchema,
  ReminderRuntimeIdInputSchema,
  SnoozeReminderInputSchema,
} from "@/surfaces/discord/runtime/reminder-inputs";
import { explicitChannelId } from "@/surfaces/discord/runtime/targets";
import { targetMatches } from "@/surfaces/discord/shared/targets";

const MIN_FOLLOWUP_INTERVAL_MINUTES = 60;

export type CreateReminderInput = z.infer<typeof CreateReminderInputSchema>;

type ReminderListScope = z.infer<typeof ListHumanRemindersInputSchema>["scope"];

export function currentTime(): {
  iso: string;
  local: string;
  timezone: string;
  epochMs: number;
} {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    iso: now.toISOString(),
    local: now.toLocaleString("en-US", { timeZone: timezone }),
    timezone,
    epochMs: now.getTime(),
  };
}

export async function createReminder(input: CreateReminderInput): Promise<{
  id: string;
  reminder: Reminder;
}> {
  const parsed = CreateReminderInputSchema.parse(input);
  const target = resolveCreateTarget(parsed);
  const id = normalizeReminderId(parsed.id ?? generateTimestampId("reminder"));
  const reminder = buildReminder({
    target,
    text: parsed.text,
    at: parsed.at,
    followupIntervalMinutes: parsed.followupIntervalMinutes,
    recurrence: parsed.recurrence,
    audienceUserIds: parsed.audienceUserIds,
    createdBy: parsed.createdBy ?? currentDiscordReminderUser(),
  });
  await writeReminder(remindersRoot(), id, reminder);
  return { id, reminder };
}

export async function listHumanReminders(
  input: z.input<typeof ListHumanRemindersInputSchema> = {},
): Promise<{ id: string; reminder: Reminder }[]> {
  const parsed = ListHumanRemindersInputSchema.parse(input);
  const target = explicitTarget(parsed.threadId, parsed.channelId);
  const currentTarget = currentDiscordTarget();
  const scope =
    parsed.scope ?? (target || currentTarget ? "current_target" : "all");
  const reminders = await listReminders(remindersRoot());
  if (scope === "all") return reminders;

  const filterTarget = target ?? targetForScope(scope, currentTarget);
  if (!filterTarget) return [];
  return reminders.filter((item) => targetMatches(item.reminder, filterTarget));
}

export async function readHumanReminder(id: string): Promise<Reminder> {
  return readReminder(
    remindersRoot(),
    normalizeReminderId(ReminderRuntimeIdInputSchema.parse(id)),
  );
}

export async function markReminderDone(
  id: string,
  doneBy?: ReminderUser,
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(
    ReminderRuntimeIdInputSchema.parse(id),
  );
  const parsedDoneBy = OptionalReminderUserInputSchema.parse(doneBy);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const updated = completedReminder(reminder, parsedDoneBy);
  await writeReminder(remindersRoot(), normalizedId, updated);
  return updated;
}

export async function deleteHumanReminder(
  id: string,
  deletedBy?: ReminderUser,
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(
    ReminderRuntimeIdInputSchema.parse(id),
  );
  const parsedDeletedBy = OptionalReminderUserInputSchema.parse(deletedBy);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const updated: Reminder = {
    ...reminder,
    status: "deleted",
    deletedAt: new Date().toISOString(),
    ...(parsedDeletedBy ? { deletedBy: parsedDeletedBy } : {}),
  };
  await writeReminder(remindersRoot(), normalizedId, updated);
  return updated;
}

export async function snoozeReminder(
  id: string,
  input: z.input<typeof SnoozeReminderInputSchema>,
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(
    ReminderRuntimeIdInputSchema.parse(id),
  );
  const parsed = SnoozeReminderInputSchema.parse(input);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const nextFireAt = parsed.until ?? minutesFromNow(parsed.minutes);
  const targetTime = new Date(nextFireAt).getTime();
  if (!Number.isFinite(targetTime)) {
    throw new Error(`Invalid snooze timestamp: ${nextFireAt}`);
  }
  const updated: Reminder = {
    ...reminder,
    status: "active",
    nextFireAt,
    snoozedUntil: nextFireAt,
  };
  await writeReminder(remindersRoot(), normalizedId, updated);
  return updated;
}

function resolveCreateTarget(input: CreateReminderInput): ReminderTarget {
  const target = explicitTarget(input.threadId, input.channelId);
  if (target) return target;

  const currentTarget = currentDiscordTarget();
  if (!currentTarget) {
    throw new Error(
      "createReminder needs a Discord target. Use it from Discord or provide threadId/channelId.",
    );
  }
  return currentTarget;
}

function explicitTarget(
  rawThreadId: string | undefined,
  rawChannelId: string | undefined,
): ReminderTarget | undefined {
  if (rawThreadId && rawChannelId) {
    throw new Error("Provide either threadId or channelId, not both.");
  }
  if (rawThreadId) {
    return { kind: "thread", threadId: explicitChannelId(rawThreadId) };
  }
  if (rawChannelId) {
    return {
      kind: "channel",
      channelId: explicitChannelId(rawChannelId),
    };
  }
  return undefined;
}

function targetForScope(
  scope: ReminderListScope,
  currentTarget: ReminderTarget | undefined,
): ReminderTarget | undefined {
  if (scope === "current_thread") {
    return currentTarget?.kind === "thread" ? currentTarget : undefined;
  }
  if (scope === "current_channel") {
    return currentTarget?.kind === "channel" ? currentTarget : undefined;
  }
  return currentTarget;
}

function buildReminder(input: {
  target: ReminderTarget;
  text: string;
  at: string | undefined;
  followupIntervalMinutes: number | undefined;
  recurrence: ReminderRecurrence | undefined;
  audienceUserIds: string[] | undefined;
  createdBy: ReminderUser | undefined;
}): Reminder {
  if (input.recurrence) validateReminderRecurrence(input.recurrence);
  const nextFireAt =
    input.at ??
    (input.recurrence
      ? nextRecurrenceRun(input.recurrence)?.toISOString()
      : undefined) ??
    new Date().toISOString();
  const targetTime = new Date(nextFireAt).getTime();
  if (!Number.isFinite(targetTime)) {
    throw new Error(`Invalid reminder timestamp: ${nextFireAt}`);
  }
  const followupIntervalMinutes =
    input.followupIntervalMinutes ?? MIN_FOLLOWUP_INTERVAL_MINUTES;
  if (
    !Number.isSafeInteger(followupIntervalMinutes) ||
    followupIntervalMinutes <= 0
  ) {
    throw new Error("followupIntervalMinutes must be a positive integer.");
  }
  const normalizedFollowupIntervalMinutes = Math.max(
    followupIntervalMinutes,
    MIN_FOLLOWUP_INTERVAL_MINUTES,
  );

  return {
    target: input.target,
    text: input.text,
    createdAt: new Date().toISOString(),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    audienceUserIds: input.audienceUserIds ?? [],
    status: "active",
    nextFireAt,
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    followupIntervalMinutes: normalizedFollowupIntervalMinutes,
    fireCount: 0,
    messageRefs: [],
  };
}

function currentDiscordTarget(): ReminderTarget | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const threadId = stringField(parsed, "threadId");
  if (threadId) return { kind: "thread", threadId };
  const channelId = stringField(parsed, "channelId");
  if (channelId) return { kind: "channel", channelId };
  return undefined;
}

function remindersRoot(): string {
  return (
    process.env["SANDI_REMINDERS_ROOT"]?.trim() ||
    `${process.env["SANDI_DATA_DIR"]?.trim() || "data"}/reminders`
  );
}

function minutesFromNow(minutes: number | undefined): string {
  if (!Number.isSafeInteger(minutes) || !minutes || minutes <= 0) {
    throw new Error(
      "minutes must be a positive integer when until is omitted.",
    );
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
