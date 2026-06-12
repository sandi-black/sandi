import { z } from "zod/v4";

const ThreadEventTargetSchema = z.object({
  kind: z.literal("thread"),
  threadId: z.string().min(1),
});

const ChannelEventTargetSchema = z.object({
  kind: z.literal("channel"),
  channelId: z.string().min(1),
});

const EventTargetSchema = z.discriminatedUnion("kind", [
  ThreadEventTargetSchema,
  ChannelEventTargetSchema,
]);

const EventCreatorSchema = z.object({
  discordUserId: z.string().min(1),
  identityId: z.string().min(1),
  username: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
});

const EventBaseSchema = z.object({
  target: EventTargetSchema,
  text: z.string().min(1),
  createdAt: z.string(),
  createdBy: EventCreatorSchema,
});

export const ImmediateEventSchema = EventBaseSchema.extend({
  type: z.literal("immediate"),
});

export const OneShotEventSchema = EventBaseSchema.extend({
  type: z.literal("one-shot"),
  at: z.string(),
});

export const PeriodicEventSchema = EventBaseSchema.extend({
  type: z.literal("periodic"),
  schedule: z.string().min(1),
  timezone: z.string().min(1),
});

export const SandiEventSchema = z.discriminatedUnion("type", [
  ImmediateEventSchema,
  OneShotEventSchema,
  PeriodicEventSchema,
]);

export type SandiEvent = z.infer<typeof SandiEventSchema>;
export type EventTarget = z.infer<typeof EventTargetSchema>;
export type EventCreator = z.infer<typeof EventCreatorSchema>;
