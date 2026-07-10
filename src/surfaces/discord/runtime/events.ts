import type { z } from "zod/v4";
import { generateTimestampId } from "@/lib/ids";
import type {
  EventCreator,
  EventTarget,
  SandiEvent,
} from "@/surfaces/discord/events/schemas";
import {
  deleteEvent,
  listEvents,
  normalizeEventId,
  readEvent,
  writeEvent,
} from "@/surfaces/discord/events/store";
import { readDiscordPlatformContext } from "@/surfaces/discord/runtime/context";
import {
  CreateEventInputSchema,
  EventRuntimeIdInputSchema,
  ListScheduledEventsInputSchema,
} from "@/surfaces/discord/runtime/event-inputs";
import { explicitChannelId } from "@/surfaces/discord/runtime/targets";
import { eventTargetMatches } from "@/surfaces/discord/shared/targets";

export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;

type EventListScope = z.infer<typeof ListScheduledEventsInputSchema>["scope"];

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

export async function createEvent(input: CreateEventInput): Promise<{
  id: string;
  event: SandiEvent;
}> {
  const parsed = CreateEventInputSchema.parse(input);
  const target = resolveCreateTarget(parsed);
  const type = parsed.type ?? inferEventType(parsed.at, parsed.schedule);
  const id = normalizeEventId(parsed.id ?? generateTimestampId(type));
  const event = buildEvent({
    type,
    target,
    text: parsed.text,
    createdBy: currentDiscordCreator(),
    at: parsed.at,
    schedule: parsed.schedule,
    timezone: parsed.timezone,
  });
  await writeEvent(eventsRoot(), id, event);
  return { id, event };
}

export async function listScheduledEvents(
  input: z.input<typeof ListScheduledEventsInputSchema> = {},
): Promise<{ id: string; event: SandiEvent }[]> {
  const parsed = ListScheduledEventsInputSchema.parse(input);
  const target = explicitTarget(parsed.threadId, parsed.channelId);
  const currentTarget = currentDiscordTarget();
  const scope =
    parsed.scope ?? (target || currentTarget ? "current_target" : "all");
  const events = await listEvents(eventsRoot());
  if (scope === "all") return events;

  const filterTarget = target ?? targetForScope(scope, currentTarget);
  if (!filterTarget) return [];
  return events.filter((item) => eventTargetMatches(item.event, filterTarget));
}

export async function readScheduledEvent(id: string): Promise<SandiEvent> {
  return readEvent(
    eventsRoot(),
    normalizeEventId(EventRuntimeIdInputSchema.parse(id)),
  );
}

export async function cancelEvent(id: string): Promise<void> {
  await deleteEvent(
    eventsRoot(),
    normalizeEventId(EventRuntimeIdInputSchema.parse(id)),
  );
}

function resolveCreateTarget(input: CreateEventInput): EventTarget {
  const target = explicitTarget(input.threadId, input.channelId);
  if (target) return target;

  const currentTarget = currentDiscordTarget();
  if (!currentTarget) {
    throw new Error(
      "createEvent needs a Discord target. Use it from Discord or provide threadId/channelId.",
    );
  }
  return currentTarget;
}

function explicitTarget(
  rawThreadId: string | undefined,
  rawChannelId: string | undefined,
): EventTarget | undefined {
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
  scope: EventListScope,
  currentTarget: EventTarget | undefined,
): EventTarget | undefined {
  if (scope === "current_thread") {
    return currentTarget?.kind === "thread" ? currentTarget : undefined;
  }
  if (scope === "current_channel") {
    return currentTarget?.kind === "channel" ? currentTarget : undefined;
  }
  return currentTarget;
}

function buildEvent(input: {
  type: SandiEvent["type"];
  target: EventTarget;
  text: string;
  createdBy: EventCreator;
  at: string | undefined;
  schedule: string | undefined;
  timezone: string | undefined;
}): SandiEvent {
  const base = {
    target: input.target,
    text: input.text,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  if (input.type === "immediate") {
    return { ...base, type: "immediate" };
  }
  if (input.type === "one-shot") {
    if (!input.at) throw new Error("one-shot events require at");
    return { ...base, type: "one-shot", at: input.at };
  }
  if (!input.schedule) throw new Error("periodic events require schedule");
  return {
    ...base,
    type: "periodic",
    schedule: input.schedule,
    timezone:
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function inferEventType(
  at: string | undefined,
  schedule: string | undefined,
): SandiEvent["type"] {
  if (schedule) return "periodic";
  if (at) return "one-shot";
  return "immediate";
}

function currentDiscordTarget(): EventTarget | undefined {
  const context = readDiscordPlatformContext();
  if (!context) return undefined;
  if (context.threadId) return { kind: "thread", threadId: context.threadId };
  if (context.channelId) {
    return { kind: "channel", channelId: context.channelId };
  }
  return undefined;
}

function currentDiscordCreator(): EventCreator {
  const context = readDiscordPlatformContext();
  if (!context) {
    throw new Error(
      "createEvent can only run from a Discord turn, because a scheduled event fires as a Discord delivery charged to its creator's Discord-mapped account. Ask the human to schedule it from Discord.",
    );
  }
  const author = context.author;
  if (!author) {
    throw new Error(
      "createEvent needs a Discord author context so future model usage can be charged to the creator's account.",
    );
  }
  if (!author.identityId) {
    throw new Error(
      "createEvent needs a mapped Discord author identity for account routing.",
    );
  }
  return {
    discordUserId: author.discordUserId,
    identityId: author.identityId,
    ...(author.username ? { username: author.username } : {}),
    ...(author.displayName ? { displayName: author.displayName } : {}),
  };
}

function eventsRoot(): string {
  return (
    process.env["SANDI_EVENTS_ROOT"]?.trim() ||
    `${process.env["SANDI_DATA_DIR"]?.trim() || "data"}/events`
  );
}
