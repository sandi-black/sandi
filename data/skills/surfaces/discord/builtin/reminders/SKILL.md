---
name: reminders
description: Use when someone asks Sandi to remind a human about something, especially when the reminder should have Done, Snooze, and Delete buttons, repeated follow-ups until handled, or a shared-room reminder prompt in Discord.
---

# Human Reminders

Use this skill when someone asks Sandi to remind a person to do, notice, or decide something later and the expected output is a human-facing Discord prompt.

Human reminders are different from scheduled tasks:

- Use a **human reminder** when the future action is for a human to acknowledge: take medicine, move laundry, check the oven, bring something, reply to someone, follow up on a chore, or any prompt that benefits from Done/Snooze/Delete buttons.
- Use a **scheduled task / scheduled event** when the future action is for Sandi herself: run a self-review, post a check-in, do a research follow-up, summarize something later, run a recurring household routine, or wake up with instructions that require Sandi judgment.
- If the request says "remind me/us/them to..." and no Sandi-only work is implied, prefer a human reminder.
- Do not convert a creator-owned scheduled event into a reminder unless the responsible human asks. Creatorless scheduled event files are invalid and should be recreated by the responsible human rather than run under a fallback account.

Use code mode through `sandi_js_run`, importing reminder helpers:

```ts
import { reminders } from "./sandi/runtime.ts";
```

Available helpers:

- `reminders.currentTime()`: get the current timestamp and local timezone before resolving relative dates.
- `reminders.createReminder(...)`: create an interactive reminder. It defaults to the current thread/channel and accepts `threadId` or `channelId` for explicit targets.
- `reminders.listHumanReminders(...)`: inspect interactive reminders.
- `reminders.readHumanReminder(id)`: read one reminder.
- `reminders.snoozeReminder(id, { minutes })` or `snoozeReminder(id, { until })`: reschedule an active reminder.
- `reminders.markReminderDone(id, doneBy?)`: mark a reminder complete.
- `reminders.deleteHumanReminder(id, deletedBy?)`: mark a reminder deleted.

Creation guidance:

1. Call `reminders.currentTime()` before turning relative language like "in 20 minutes" or "tomorrow" into an ISO timestamp.
2. Use `reminders.createReminder` with:
   - `text`: the exact human-facing reminder text.
   - `at`: ISO 8601 timestamp for the first prompt; omit only for an immediate reminder.
   - `followupIntervalMinutes`: how often to post follow-ups if nobody clicks Done. Use `60` when unspecified, or a tighter interval for urgent reminders.
   - `recurrence`: optional `{ schedule, timezone }` for recurring human reminders. `schedule` is cron syntax and `timezone` is an IANA timezone such as `America/Los_Angeles`.
   - `audienceUserIds`: Discord user IDs to mention, when clear from context.
   - `createdBy`: omit this unless you need to override it; the runtime stamps the current Discord requester, including mapped identity, by default.
3. After creating it, say briefly where and when it will fire and what the follow-up interval is.

When a reminder fires, Sandi posts a Discord prompt with Done, Snooze, and Delete controls. Done stops follow-ups for a one-time reminder. For a recurring reminder, Done completes the current occurrence, clears the visible prompt, and schedules the next occurrence. Snooze delays the current occurrence/follow-up. Delete asks for confirmation and deletes the whole reminder, including future recurrence. These button interactions affect only the new reminder object, not old scheduled events.

For configured clean task channels, clicking Done on an interactive reminder should mark the reminder done durably and remove the visible prompt so the task channel does not accumulate completed reminder messages. Todo/task channel prefixes are handled automatically; set `SANDI_REMINDER_CLEAN_HANDLED_CHANNELS` for exact channel-name matches.
