import { randomUUID } from "node:crypto";

import { discordChannelIdFromRef } from "@/surfaces/discord/discord/ids";
import {
  nextRecurrenceRun,
  nextReminderRecurrenceRun,
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
import { readDiscordPlatformContext } from "@/surfaces/discord/runtime/context";

const MIN_FOLLOWUP_INTERVAL_MINUTES = 60;

export type CreateReminderInput = {
  id?: string;
  text: string;
  at?: string;
  followupIntervalMinutes?: number;
  recurrence?: ReminderRecurrence;
  audienceUserIds?: string[];
  createdBy?: ReminderUser;
  threadId?: string;
  channelId?: string;
};

type ReminderListScope =
  | "current_target"
  | "current_thread"
  | "current_channel"
  | "all";

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
  const target = resolveCreateTarget(input);
  const id = normalizeReminderId(input.id ?? generatedReminderId());
  const reminder = buildReminder({
    target,
    text: input.text,
    at: input.at,
    followupIntervalMinutes: input.followupIntervalMinutes,
    recurrence: input.recurrence,
    audienceUserIds: input.audienceUserIds,
    createdBy: input.createdBy ?? currentDiscordReminderUser(),
  });
  await writeReminder(remindersRoot(), id, reminder);
  return { id, reminder };
}

export async function listHumanReminders(
  input: {
    scope?: ReminderListScope;
    threadId?: string;
    channelId?: string;
  } = {},
): Promise<{ id: string; reminder: Reminder }[]> {
  const target = explicitTarget(input.threadId, input.channelId);
  const currentTarget = currentDiscordTarget();
  const scope =
    input.scope ?? (target || currentTarget ? "current_target" : "all");
  const reminders = await listReminders(remindersRoot());
  if (scope === "all") return reminders;

  const filterTarget = target ?? targetForScope(scope, currentTarget);
  if (!filterTarget) return [];
  return reminders.filter((item) => targetMatches(item.reminder, filterTarget));
}

export async function readHumanReminder(id: string): Promise<Reminder> {
  return readReminder(remindersRoot(), normalizeReminderId(id));
}

export async function markReminderDone(
  id: string,
  doneBy?: ReminderUser,
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(id);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const updated = completedReminder(reminder, doneBy);
  await writeReminder(remindersRoot(), normalizedId, updated);
  return updated;
}

export async function deleteHumanReminder(
  id: string,
  deletedBy?: ReminderUser,
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(id);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const updated: Reminder = {
    ...reminder,
    status: "deleted",
    deletedAt: new Date().toISOString(),
    ...(deletedBy ? { deletedBy } : {}),
  };
  await writeReminder(remindersRoot(), normalizedId, updated);
  return updated;
}

export async function snoozeReminder(
  id: string,
  input: { until?: string; minutes?: number },
): Promise<Reminder> {
  const normalizedId = normalizeReminderId(id);
  const reminder = await readReminder(remindersRoot(), normalizedId);
  const nextFireAt = input.until ?? minutesFromNow(input.minutes);
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
    return { kind: "thread", threadId: discordChannelIdFromRef(rawThreadId) };
  }
  if (rawChannelId) {
    return {
      kind: "channel",
      channelId: discordChannelIdFromRef(rawChannelId),
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

function targetMatches(reminder: Reminder, target: ReminderTarget): boolean {
  if (reminder.target.kind === "thread" && target.kind === "thread") {
    return reminder.target.threadId === target.threadId;
  }
  if (reminder.target.kind === "channel" && target.kind === "channel") {
    return reminder.target.channelId === target.channelId;
  }
  return false;
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

function completedReminder(
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

function generatedReminderId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
  return `reminder_${stamp}_${randomUUID().slice(0, 8)}`;
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

function currentDiscordReminderUser(): ReminderUser | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const author = parsed["author"];
  if (!isRecord(author)) return undefined;
  const discordUserId = stringField(author, "discordUserId");
  if (!discordUserId) return undefined;
  return {
    discordUserId,
    ...(stringField(author, "username")
      ? { username: stringField(author, "username") }
      : {}),
    ...(stringField(author, "displayName")
      ? { displayName: stringField(author, "displayName") }
      : {}),
    ...(stringField(author, "identityId")
      ? { identityId: stringField(author, "identityId") }
      : {}),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
