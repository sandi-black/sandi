import { Cron } from "croner";

import { z } from "zod/v4";
import { DiscordChannelRefSchema } from "@/surfaces/discord/runtime/targets";

const EventIdInputSchema = z.string().trim().min(1, "id must not be empty");
export const EventRuntimeIdInputSchema = EventIdInputSchema;

const EventTextInputSchema = z
  .string()
  .trim()
  .min(1, "event text must not be empty");

const EventTimestampInputSchema = z
  .string()
  .trim()
  .pipe(z.iso.datetime({ offset: true }))
  .transform((value) => new Date(value).toISOString());

const EventScheduleInputSchema = z
  .string()
  .trim()
  .min(1, "schedule must not be empty")
  .transform((value, context) => {
    try {
      new Cron(value, { paused: true }).stop();
    } catch {
      context.addIssue({
        code: "custom",
        message: "schedule must be a valid cron expression",
      });
      return z.NEVER;
    }
    return value;
  });

const EventTimezoneInputSchema = z
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

export const EventListScopeSchema = z.enum([
  "current_target",
  "current_thread",
  "current_channel",
  "all",
]);

export const CreateEventInputSchema = z
  .object({
    type: z.enum(["immediate", "one-shot", "periodic"]).optional(),
    id: EventIdInputSchema.optional(),
    text: EventTextInputSchema,
    at: EventTimestampInputSchema.optional(),
    schedule: EventScheduleInputSchema.optional(),
    timezone: EventTimezoneInputSchema.optional(),
    threadId: DiscordChannelRefSchema.optional(),
    channelId: DiscordChannelRefSchema.optional(),
  })
  .refine(
    (input) => !(input.threadId && input.channelId),
    "provide either threadId or channelId, not both",
  )
  .refine(
    (input) => !(input.at && input.schedule),
    "provide either at or schedule, not both",
  )
  .refine(
    (input) => input.type !== "one-shot" || Boolean(input.at),
    "one-shot events require at",
  )
  .refine(
    (input) => input.type !== "periodic" || Boolean(input.schedule),
    "periodic events require schedule",
  )
  .refine(
    (input) => input.type !== "immediate" || !input.at,
    "immediate events cannot include at",
  )
  .refine(
    (input) => input.type !== "immediate" || !input.schedule,
    "immediate events cannot include schedule",
  );

export const ListScheduledEventsInputSchema = z
  .object({
    scope: EventListScopeSchema.optional(),
    threadId: DiscordChannelRefSchema.optional(),
    channelId: DiscordChannelRefSchema.optional(),
  })
  .refine(
    (input) => !(input.threadId && input.channelId),
    "provide either threadId or channelId, not both",
  );
