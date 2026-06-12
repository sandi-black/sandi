import { randomUUID } from "node:crypto";

import { discordChannelIdFromRef } from "@/surfaces/discord/discord/ids";
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

export type CreateEventInput = {
  type?: SandiEvent["type"];
  id?: string;
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
  threadId?: string;
  channelId?: string;
};

type EventListScope =
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

export async function createEvent(input: CreateEventInput): Promise<{
  id: string;
  event: SandiEvent;
}> {
  const target = resolveCreateTarget(input);
  const type = input.type ?? inferEventType(input.at, input.schedule);
  const id = normalizeEventId(input.id ?? generatedEventId(type));
  const event = buildEvent({
    type,
    target,
    text: input.text,
    createdBy: currentDiscordCreator(),
    at: input.at,
    schedule: input.schedule,
    timezone: input.timezone,
  });
  await writeEvent(eventsRoot(), id, event);
  return { id, event };
}

export async function listScheduledEvents(
  input: { scope?: EventListScope; threadId?: string; channelId?: string } = {},
): Promise<{ id: string; event: SandiEvent }[]> {
  const target = explicitTarget(input.threadId, input.channelId);
  const currentTarget = currentDiscordTarget();
  const scope =
    input.scope ?? (target || currentTarget ? "current_target" : "all");
  const events = await listEvents(eventsRoot());
  if (scope === "all") return events;

  const filterTarget = target ?? targetForScope(scope, currentTarget);
  if (!filterTarget) return [];
  return events.filter((item) => eventTargetMatches(item.event, filterTarget));
}

export async function readScheduledEvent(id: string): Promise<SandiEvent> {
  return readEvent(eventsRoot(), normalizeEventId(id));
}

export async function cancelEvent(id: string): Promise<void> {
  await deleteEvent(eventsRoot(), normalizeEventId(id));
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

function eventTargetMatches(event: SandiEvent, target: EventTarget): boolean {
  if (event.target.kind === "thread" && target.kind === "thread") {
    return event.target.threadId === target.threadId;
  }
  if (event.target.kind === "channel" && target.kind === "channel") {
    return event.target.channelId === target.channelId;
  }
  return false;
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

function generatedEventId(type: SandiEvent["type"]): string {
  return `${type}-${randomUUID().slice(0, 8)}`;
}

function currentDiscordTarget(): EventTarget | undefined {
  const raw = readDiscordPlatformContext();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  const threadId = stringField(parsed, "threadId");
  if (threadId) return { kind: "thread", threadId };
  const channelId = stringField(parsed, "channelId");
  if (channelId) return { kind: "channel", channelId };
  return undefined;
}

function currentDiscordCreator(): EventCreator {
  const raw = readDiscordPlatformContext();
  if (!raw) {
    throw new Error(
      "createEvent needs a Discord author context so future model usage can be charged to the creator's account.",
    );
  }
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Discord platform context is not an object.");
  }
  const author = parsed["author"];
  if (!isRecord(author)) {
    throw new Error(
      "createEvent needs a Discord author context so future model usage can be charged to the creator's account.",
    );
  }
  const discordUserId = stringField(author, "discordUserId");
  const identityId = stringField(author, "identityId");
  if (!discordUserId || !identityId) {
    throw new Error(
      "createEvent needs a mapped Discord author identity for account routing.",
    );
  }
  return {
    discordUserId,
    identityId,
    ...(stringField(author, "username")
      ? { username: stringField(author, "username") }
      : {}),
    ...(stringField(author, "displayName")
      ? { displayName: stringField(author, "displayName") }
      : {}),
  };
}

function eventsRoot(): string {
  return (
    process.env["SANDI_EVENTS_ROOT"]?.trim() ||
    `${process.env["SANDI_DATA_DIR"]?.trim() || "data"}/events`
  );
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
