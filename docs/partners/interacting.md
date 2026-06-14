# Interacting With Sandi

Sandi is meant to feel like a local presence in a shared space. She can talk,
remember, follow up, keep todo lists, help with recurring workflows, and grow new
habits as people collaborate with her.

## Conversations

Sandi's current primary home is Discord.

- Start a conversation by creating a post in Sandi's forum channel.
- Mention Sandi in a top-level text channel to start a dedicated thread
  conversation from that message.
- Reply inside a Sandi-managed thread without mentioning her; the thread already
  belongs to that conversation.

Forum posts, automatic channel rooms, and Sandi-managed threads all carry their
own continuity. Sandi can keep separate context for different rooms, topics,
threads, and people.

## Commands

Run `/sandi help` in Discord to see the current command list.

Common commands:

- `/sandi todo`: create and pin an interactive todo list.
- `/sandi status`: inspect Sandi's runtime health and current conversation
  status.
- `/sandi stop`: ask the current turn in this conversation to stop.
- `/sandi events list`: inspect scheduled Sandi events.
- `/sandi reminders list`: inspect interactive human reminders.

## Memory

Sandi's memory is meant to be visible continuity, not hidden surveillance. Good
memory feels like being known: preferences, ongoing projects, household rhythms,
and useful context that should survive beyond one conversation.

When Sandi writes memory, she should summarize what changed so people can correct
it. A live deployment can edit memory directly when something needs to be
removed, softened, or moved to a narrower scope.

## Reminders, Events, And Todos

Sandi can help with future-oriented work in two different ways:

- Human reminders are for a person to acknowledge later. They can include
  Done/Snooze/Delete controls and repeated follow-ups. Follow-up pings are
  intentionally rate-limited: at least 1 hour apart, and no more than 3 fires in
  a rolling 24-hour window.
- Scheduled events are for Sandi herself to wake up later with instructions,
  make a judgment, post a check-in, or run a recurring routine.

Todo lists are interactive Discord messages that Sandi can create and update in
the current channel or thread.

## Shared Spaces

Sandi should treat Discord channels and threads as shared rooms. She can join in,
stay quiet, react to messages, and send status updates when work takes time.

For sensitive actions, Sandi should ask first: changing shared state, relying on
someone's account, exposing private information, spending money, or doing
something hard to undo.

## Customization

Every live Sandi can become different. Her soul, memory, skills, policies, and
per-person preferences can all change with the household. See
[Personalizing Sandi](personalization.md) for the broader model.
