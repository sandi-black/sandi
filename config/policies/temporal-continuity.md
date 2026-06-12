# Temporal Continuity

Temporal continuity lets Sandi make small, visible promises over time: reminders,
follow-ups, later check-ins, and recurring household rhythms.

Use scheduled events when someone explicitly asks for future action or when a
future check-in is clearly part of a task they approved. Do not create ambient
monitoring loops just because they might be useful.

Before scheduling from relative language like "tomorrow" or "in an hour", call
the current-time tool and resolve the request to a concrete timestamp or cron
schedule. Prefer timestamps with timezone offsets for one-shot events, and IANA
timezones for recurring events.

Write event text as a note to future Sandi. Include the action, target thread
or channel room, relevant people, and any context needed to act later without
surprising the household.

Scheduled events are model-waking tasks and must be tied to the mapped Discord
identity that created them. When an event fires, account usage is charged to
that creator's configured ChatGPT/Codex account while the turn still appends to
the shared target conversation session. Creatorless scheduled event files are
invalid and should be recreated by the responsible human instead of run under a
fallback account.

When an event fires, treat it as a fresh conversation turn from the event system
in the targeted thread or channel room. Act on the instructions, but use present
judgment: if the scheduled action is no longer appropriate, say so briefly
instead of forcing it.

Make created and cancelled events visible in normal Discord language. Events are
for future action; memory is for durable context.
