---
name: temporal-continuity
description: Use for scheduled Sandi tasks, follow-ups, scheduled check-ins, recurring tasks, future Sandi actions, event turns, or canceling/listing scheduled events.
---

# Temporal Continuity / Scheduled Tasks

Use this skill when someone asks Sandi to do something in the future: Sandi follow-ups, later check-ins, recurring household rhythms, or a scheduled-event turn that has fired.

Scheduled tasks are different from human reminders:

- Use a **scheduled task / scheduled event** when the future action is for Sandi herself: run a self-review, post a check-in, do a research follow-up, summarize something later, run a recurring household routine, or wake up with instructions that require Sandi judgment.
- Use a **human reminder** when the future action is for a human to acknowledge and would benefit from a Discord prompt with Done/Snooze/Delete buttons.
- If the request says "remind me/us/them to..." and Sandi does not need to do future reasoning or work, prefer the `reminders` skill instead.
- Scheduled events are model-waking tasks. They must be created from a mapped Discord human identity, and future model usage is charged to that creator's configured ChatGPT/Codex account. Creatorless scheduled event files are invalid; recreate them with the responsible human instead of running them under a fallback account.

Use code mode through `sandi_js_run`, importing event helpers:

```ts
import { events } from "./sandi/runtime.ts";
```

Available helpers:

- `events.currentTime()`: get the current timestamp and timezone before resolving relative dates.
- `events.createEvent(...)`: create an immediate, one-shot, or periodic event for a Discord forum thread or standing channel room. It defaults to the current thread/channel, and accepts `threadId` or `channelId` for explicit targets. Those target fields can be raw ids, Discord channel mentions, or Discord message URLs.
- `events.listScheduledEvents(...)`: inspect scheduled events.
- `events.readScheduledEvent(id)`: read exact event instructions or schedule details.
- `events.cancelEvent(id)`: cancel a scheduled event.

Prefer this flow:

1. Confirm the user is asking for future Sandi action, not just durable context or a human-facing reminder. Future Sandi action belongs in events; durable context belongs in memory; human prompts belong in reminders.
2. Call `events.currentTime()` before turning relative language like "tomorrow", "in an hour", or "next Friday" into a schedule.
3. Use concrete ISO 8601 timestamps with timezone offsets for one-shot events.
4. Use cron syntax plus an IANA timezone for recurring events.
5. Write event text as a note to future Sandi. Include what to do, which thread or channel room should receive it, who it concerns, and enough context to act without surprising the household.
6. Let `events.createEvent(...)` stamp the current mapped human as creator. Do not hand-write event JSON or remove `createdBy`.
7. Make created and cancelled events visible in normal Discord language.

Do not create ambient monitoring loops just because they might be useful. Use scheduled events when someone explicitly asks for future Sandi action or when a future check-in is clearly part of an approved task.

When a scheduled event fires, treat it as a fresh turn from the event system. Act on the event instructions in the targeted Discord conversation target, whether that is a forum thread or a standing channel room, but use present judgment: if the action is unclear or no longer appropriate, say so briefly instead of forcing it.

If the policy details matter, read `temporal-continuity.md` with `policy_read`.
