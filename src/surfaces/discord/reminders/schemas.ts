import { z } from "zod/v4";

const ThreadReminderTargetSchema = z.object({
  kind: z.literal("thread"),
  threadId: z.string().min(1),
});

const ChannelReminderTargetSchema = z.object({
  kind: z.literal("channel"),
  channelId: z.string().min(1),
});

export const ReminderTargetSchema = z.discriminatedUnion("kind", [
  ThreadReminderTargetSchema,
  ChannelReminderTargetSchema,
]);

const ReminderUserSchema = z.object({
  discordUserId: z.string().min(1),
  username: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  identityId: z.string().min(1).optional(),
});

const ReminderMessageRefSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
});

const CalendarReminderRecurrenceSchema = z.object({
  kind: z.literal("calendar"),
  schedule: z.string().min(1),
  timezone: z.string().min(1),
});

const CompletionIntervalReminderRecurrenceSchema = z.object({
  kind: z.literal("completion-interval"),
  everyDays: z.number().int().positive(),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: z.string().min(1),
});

const ReminderRecurrenceSchema = z.discriminatedUnion("kind", [
  CalendarReminderRecurrenceSchema,
  CompletionIntervalReminderRecurrenceSchema,
]);

export const ReminderSchema = z.object({
  target: ReminderTargetSchema,
  text: z.string().min(1),
  createdAt: z.string(),
  createdBy: ReminderUserSchema.optional(),
  audienceUserIds: z.array(z.string().min(1)),
  status: z.enum(["active", "done", "deleted"]),
  nextFireAt: z.string(),
  recurrence: ReminderRecurrenceSchema.optional(),
  followupIntervalMinutes: z.number().int().positive(),
  fireCount: z.number().int().nonnegative(),
  lastFiredAt: z.string().optional(),
  recentFireAts: z.array(z.string()).optional(),
  snoozedUntil: z.string().optional(),
  doneAt: z.string().optional(),
  doneBy: ReminderUserSchema.optional(),
  deletedAt: z.string().optional(),
  deletedBy: ReminderUserSchema.optional(),
  messageRefs: z.array(ReminderMessageRefSchema),
});

export type Reminder = z.infer<typeof ReminderSchema>;
export type ReminderTarget = z.infer<typeof ReminderTargetSchema>;
export type ReminderUser = z.infer<typeof ReminderUserSchema>;
export type ReminderMessageRef = z.infer<typeof ReminderMessageRefSchema>;
export type ReminderRecurrence = z.infer<typeof ReminderRecurrenceSchema>;
export type ReminderCompletionIntervalRecurrence = z.infer<
  typeof CompletionIntervalReminderRecurrenceSchema
>;
