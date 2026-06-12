import { randomUUID } from "node:crypto";

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { discordChannelIdFromRef } from "../discord/ids";
import type { EventCreator, EventTarget, SandiEvent } from "../events/schemas";
import {
  deleteEvent,
  listEvents,
  normalizeEventId,
  readEvent,
  writeEvent,
} from "../events/store";
import { readDiscordPlatformContext } from "../runtime/context";
import { z } from "zod/v4";

type DiscordContext = {
  channelId?: string;
  threadId?: string;
  author?: EventCreator;
};

const DiscordContextSchema = z.object({
  channelId: z.string().optional(),
  threadId: z.string().optional(),
  author: z
    .object({
      discordUserId: z.string().min(1),
      identityId: z.string().min(1),
      username: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
    })
    .optional(),
});

const EventIdParam = Type.String({
  description:
    "Event id, such as follow-up-design-review. Use event_list to inspect ids.",
});

export default function eventToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "event_current_time",
      label: "Current Time",
      description:
        "Get the current datetime stamp for scheduling scheduled events and Sandi follow-ups.",
      promptSnippet:
        "Use this before creating scheduled events so relative times are anchored to the current date, time, and timezone. For human-facing reminders with Done/Snooze/Delete controls, use the reminders runtime helper instead.",
      parameters: Type.Object({}),
      async execute() {
        const now = new Date();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return textResult(
          [
            `iso: ${now.toISOString()}`,
            `local: ${now.toLocaleString("en-US", { timeZone: timezone })}`,
            `timezone: ${timezone}`,
            `epoch_ms: ${now.getTime()}`,
          ].join("\n"),
          {
            iso: now.toISOString(),
            timezone,
            epochMs: now.getTime(),
          },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "event_create",
      label: "Create Event",
      description:
        "Schedule temporal continuity for a Sandi Discord thread or standing channel room. Creates an immediate, one-shot, or periodic event that later returns as a fresh Sandi turn.",
      promptSnippet:
        "Create an event when the future action is for Sandi herself: follow up, check back later, run a recurring household task, or wake up with instructions. Use human reminders instead for prompts that should have Done/Snooze/Delete controls. Use event_current_time first for relative dates. Default to the current thread/channel unless the user clearly names another target.",
      parameters: Type.Object({
        type: Type.Optional(
          Type.String({
            description:
              "immediate, one-shot, or periodic. Defaults to one-shot when at is provided, periodic when schedule is provided, otherwise immediate.",
          }),
        ),
        id: Type.Optional(
          Type.String({
            description:
              "Optional stable lowercase id. If omitted, Sandi generates one.",
          }),
        ),
        text: Type.String({
          description:
            "Specific instructions for future Sandi. Include what to do and where/context enough to act later.",
        }),
        at: Type.Optional(
          Type.String({
            description:
              "ISO 8601 timestamp for a one-shot event, with timezone offset when possible.",
          }),
        ),
        schedule: Type.Optional(
          Type.String({
            description: "Cron expression for a periodic event.",
          }),
        ),
        timezone: Type.Optional(
          Type.String({
            description:
              "IANA timezone for a periodic event, such as America/Los_Angeles.",
          }),
        ),
        threadId: Type.Optional(
          Type.String({
            description:
              "Discord forum thread target as a raw id, <#mention>, or Discord message URL. Defaults to the current thread/channel target when omitted.",
          }),
        ),
        channelId: Type.Optional(
          Type.String({
            description:
              "Discord standing channel target as a raw id, <#mention>, or Discord message URL. Use this for normal channels, not forum threads.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const target = resolveCreateTarget({
          context: readDiscordContext(),
          threadId: params.threadId,
          channelId: params.channelId,
        });
        const type = inferEventType(params.type, params.at, params.schedule);
        const id = normalizeEventId(params.id ?? generatedEventId(type));
        const event = buildEvent({
          type,
          target,
          text: params.text,
          createdBy: creatorFromContext(readDiscordContext()),
          at: params.at,
          schedule: params.schedule,
          timezone: params.timezone,
        });
        await writeEvent(readEventsRoot(), id, event);
        return textResult(formatEvent(id, event), {
          id,
          type,
          target,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "event_list",
      label: "List Events",
      description:
        "List scheduled Sandi events. Defaults to the current thread or channel room when available.",
      promptSnippet:
        "List events when asked what scheduled Sandi tasks exist or before cancelling one. Use reminder helpers for human-facing reminders.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.String({
            description:
              "current_target, current_thread, current_channel, or all. Defaults to current_target when a Discord target is active, otherwise all.",
          }),
        ),
        threadId: Type.Optional(
          Type.String({
            description:
              "Optional thread target filter as raw id, <#mention>, or Discord URL.",
          }),
        ),
        channelId: Type.Optional(
          Type.String({
            description:
              "Optional channel target filter as raw id, <#mention>, or Discord URL.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const context = readDiscordContext();
        const explicit = explicitTarget(params.threadId, params.channelId);
        const current = currentTarget(context);
        const scope =
          params.scope ?? (explicit || current ? "current_target" : "all");
        const filterTarget = explicit ?? targetForScope(scope, current);
        const events = (await listEvents(readEventsRoot())).filter((item) => {
          if (scope === "all" && !explicit) return true;
          return !!filterTarget && eventTargetMatches(item.event, filterTarget);
        });
        return textResult(
          events.length > 0
            ? events
                .map((item) => formatEvent(item.id, item.event))
                .join("\n\n")
            : "No scheduled events found.",
          { count: events.length, scope, target: filterTarget },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "event_read",
      label: "Read Event",
      description: "Read one scheduled Sandi event by id.",
      promptSnippet:
        "Read an event when you need exact future-self instructions or schedule details.",
      parameters: Type.Object({
        id: EventIdParam,
      }),
      async execute(_toolCallId, params) {
        const id = normalizeEventId(params.id);
        const event = await readEvent(readEventsRoot(), id);
        return textResult(formatEvent(id, event), { id, type: event.type });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "event_cancel",
      label: "Cancel Event",
      description:
        "Cancel a scheduled Sandi event by id. Use when asked to cancel, stop, or remove a scheduled Sandi task/follow-up.",
      promptSnippet:
        "Cancel events only when the user asks or when an event is clearly wrong. Use reminder helpers for human-facing reminders.",
      parameters: Type.Object({
        id: EventIdParam,
      }),
      async execute(_toolCallId, params) {
        const id = normalizeEventId(params.id);
        await deleteEvent(readEventsRoot(), id);
        return textResult(`Event cancelled: ${id}`, { id });
      },
    }),
  );
}

function readEventsRoot(): string {
  const value = process.env["SANDI_EVENTS_ROOT"]?.trim();
  if (value) return value;
  const dataDir = process.env["SANDI_DATA_DIR"]?.trim() || "./data";
  return `${dataDir}/events`;
}

function readDiscordContext(): DiscordContext {
  const raw = readDiscordPlatformContext();
  if (!raw) return {};
  const parsed = DiscordContextSchema.parse(JSON.parse(raw));
  const context: DiscordContext = {};
  if (parsed.channelId) context.channelId = parsed.channelId;
  if (parsed.threadId) context.threadId = parsed.threadId;
  if (parsed.author) context.author = parsed.author;
  return context;
}

function creatorFromContext(context: DiscordContext): EventCreator {
  if (context.author) return context.author;
  throw new Error(
    "event_create needs a mapped Discord author identity for account routing.",
  );
}

function resolveCreateTarget(input: {
  context: DiscordContext;
  threadId: string | undefined;
  channelId: string | undefined;
}): EventTarget {
  const explicit = explicitTarget(input.threadId, input.channelId);
  if (explicit) return explicit;
  const current = currentTarget(input.context);
  if (!current) {
    throw new Error(
      "event_create needs a Discord target. Use it from Discord or provide threadId/channelId.",
    );
  }
  return current;
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

function currentTarget(context: DiscordContext): EventTarget | undefined {
  if (context.threadId) return { kind: "thread", threadId: context.threadId };
  if (context.channelId)
    return { kind: "channel", channelId: context.channelId };
  return undefined;
}

function targetForScope(
  scope: string,
  current: EventTarget | undefined,
): EventTarget | undefined {
  if (scope === "all") return undefined;
  if (scope === "current_thread") {
    return current?.kind === "thread" ? current : undefined;
  }
  if (scope === "current_channel") {
    return current?.kind === "channel" ? current : undefined;
  }
  if (scope === "current_target") return current;
  throw new Error(`Unknown event list scope: ${scope}`);
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

function inferEventType(
  requested: string | undefined,
  at: string | undefined,
  schedule: string | undefined,
): SandiEvent["type"] {
  if (
    requested === "immediate" ||
    requested === "one-shot" ||
    requested === "periodic"
  ) {
    return requested;
  }
  if (schedule) return "periodic";
  if (at) return "one-shot";
  return "immediate";
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
  if (input.type === "immediate") return { ...base, type: "immediate" };
  if (input.type === "one-shot") {
    if (!input.at) throw new Error("at is required for one-shot events.");
    const targetTime = new Date(input.at).getTime();
    if (!Number.isFinite(targetTime)) {
      throw new Error(`Invalid one-shot timestamp: ${input.at}`);
    }
    return { ...base, type: "one-shot", at: input.at };
  }
  if (!input.schedule)
    throw new Error("schedule is required for periodic events.");
  return {
    ...base,
    type: "periodic",
    schedule: input.schedule,
    timezone:
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function generatedEventId(type: SandiEvent["type"]): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
  return `${type.replace("-", "_")}_${stamp}_${randomUUID().slice(0, 8)}`;
}

function formatEvent(id: string, event: SandiEvent): string {
  const schedule =
    event.type === "one-shot"
      ? `at=${event.at}`
      : event.type === "periodic"
        ? `schedule=${event.schedule} timezone=${event.timezone}`
        : "immediate";
  return [
    `Event ${id}`,
    `type=${event.type}`,
    `target=${formatTarget(event.target)}`,
    schedule,
    `createdAt=${event.createdAt}`,
    `createdBy=${event.createdBy.identityId} (${event.createdBy.discordUserId})`,
    "text:",
    event.text,
  ].join("\n");
}

function formatTarget(target: EventTarget): string {
  if (target.kind === "thread") return `thread:${target.threadId}`;
  return `channel:${target.channelId}`;
}

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
