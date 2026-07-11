import { Cron } from "croner";

import { z } from "zod/v4";
import {
  DiscordChannelRefSchema,
  DiscordMessageIdSchema,
} from "@/surfaces/discord/runtime/targets";

const ReminderIdInputSchema = z.string().trim().min(1, "id must not be empty");
export const ReminderRuntimeIdInputSchema = ReminderIdInputSchema;

const ReminderTextInputSchema = z
  .string()
  .trim()
  .min(1, "reminder text must not be empty");

export const ReminderTimestampInputSchema = z
  .string()
  .trim()
  .pipe(z.iso.datetime({ offset: true }))
  .transform((value) => new Date(value).toISOString());

const ReminderTimezoneInputSchema = z
  .string()
  .trim()
  .min(1, "timezone must not be empty")
  .transform((value, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
      context.addIssue({
        code: "custom",
        message: "timezone must be a valid IANA time zone",
      });
      return z.NEVER;
    }
    return value;
  });

const ReminderScheduleInputSchema = z
  .string()
  .trim()
  .min(1, "schedule must not be empty");

export const ReminderRecurrenceInputSchema = z
  .object({
    schedule: ReminderScheduleInputSchema,
    timezone: ReminderTimezoneInputSchema,
  })
  .transform((value, context) => {
    try {
      new Cron(value.schedule, {
        paused: true,
        timezone: value.timezone,
      }).stop();
    } catch {
      context.addIssue({
        code: "custom",
        message: "recurrence must use a valid cron expression and timezone",
      });
      return z.NEVER;
    }
    return value;
  });

export const ReminderUserInputSchema = z.object({
  discordUserId: DiscordMessageIdSchema,
  username: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  identityId: z.string().trim().min(1).optional(),
});

const ReminderListScopeSchema = z.enum([
  "current_target",
  "current_thread",
  "current_channel",
  "all",
]);

export const CreateReminderInputSchema = z
  .object({
    id: ReminderIdInputSchema.optional(),
    text: ReminderTextInputSchema,
    at: ReminderTimestampInputSchema.optional(),
    followupIntervalMinutes: z.number().finite().int().positive().optional(),
    recurrence: ReminderRecurrenceInputSchema.optional(),
    audienceUserIds: z.array(DiscordMessageIdSchema).optional(),
    createdBy: ReminderUserInputSchema.optional(),
    threadId: DiscordChannelRefSchema.optional(),
    channelId: DiscordChannelRefSchema.optional(),
  })
  .refine(
    (input) => !(input.threadId && input.channelId),
    "provide either threadId or channelId, not both",
  );

export const ListHumanRemindersInputSchema = z
  .object({
    scope: ReminderListScopeSchema.optional(),
    threadId: DiscordChannelRefSchema.optional(),
    channelId: DiscordChannelRefSchema.optional(),
  })
  .refine(
    (input) => !(input.threadId && input.channelId),
    "provide either threadId or channelId, not both",
  );

export const OptionalReminderUserInputSchema =
  ReminderUserInputSchema.optional();

export const SnoozeReminderInputSchema = z
  .object({
    until: ReminderTimestampInputSchema.optional(),
    minutes: z.number().finite().int().positive().optional(),
  })
  .refine(
    (input) => Boolean(input.until) !== Boolean(input.minutes),
    "provide exactly one of until or minutes",
  );
