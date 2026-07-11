import assert from "node:assert/strict";
import { join } from "node:path";

import { DurableOutbox } from "@/lib/delivery/outbox";
import { withTempDir } from "@/lib/verification/harness";
import {
  enqueueDiscordEvent,
  registerDiscordEventDelivery,
} from "@/surfaces/discord/bot/event-delivery";
import {
  enqueueDiscordReminder,
  registerDiscordReminderDelivery,
} from "@/surfaces/discord/bot/reminder-delivery";
import { readEvent, writeEvent } from "@/surfaces/discord/events/store";
import {
  type EventTrigger,
  EventWatcher,
} from "@/surfaces/discord/events/watcher";

await withTempDir("sandi-scheduled-outbox-", async (root) => {
  const path = join(root, "outbox.json");
  const beforeRestart = new DurableOutbox(path);
  const event: EventTrigger = {
    id: "ada-review",
    occurrence: "2026-07-10T06:00:00.000Z",
    label: "[EVENT:ada-review:one-shot:overdue]",
    event: {
      type: "one-shot",
      at: "2026-07-10T06:00:00.000Z",
      target: { kind: "channel", channelId: "channel-1" },
      text: "Review the compiler notes",
      createdAt: "2026-07-09T06:00:00.000Z",
      createdBy: {
        discordUserId: "ada-discord",
        identityId: "ada",
        username: "ada-lovelace",
      },
    },
  };
  await enqueueDiscordEvent(beforeRestart, event);
  await enqueueDiscordReminder(beforeRestart, {
    id: "todo-item-grace-reminder",
    scheduledFireAt: "2026-07-10T06:05:00.000Z",
  });
  assert.equal((await beforeRestart.list()).length, 2);

  const afterRestart = new DurableOutbox(path);
  const delivered: string[] = [];
  registerDiscordEventDelivery(afterRestart, async (trigger) => {
    delivered.push(`event:${trigger.id}:${trigger.occurrence}`);
  });
  registerDiscordReminderDelivery(afterRestart, async (payload) => {
    delivered.push(`reminder:${payload.id}:${payload.scheduledFireAt}`);
  });
  afterRestart.start();
  for (let index = 0; index < 200; index += 1) {
    if (
      (await afterRestart.list()).every(
        (record) => record.status === "completed",
      )
    ) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  afterRestart.stop();
  assert.deepEqual(delivered, [
    "event:ada-review:2026-07-10T06:00:00.000Z",
    "reminder:todo-item-grace-reminder:2026-07-10T06:05:00.000Z",
  ]);
  assert(
    (await afterRestart.list()).every(
      (record) => record.status === "completed",
    ),
  );

  const eventsRoot = join(root, "events");
  await writeEvent(eventsRoot, "durable-immediate", {
    type: "immediate",
    target: { kind: "channel", channelId: "channel-1" },
    text: "Inspect the durable queue",
    createdAt: "2026-07-10T07:00:00.000Z",
    createdBy: {
      discordUserId: "grace-discord",
      identityId: "grace",
    },
  });
  let existedWhenEnqueued = false;
  let enqueueAttempts = 0;
  const watcher = new EventWatcher(eventsRoot, async (trigger) => {
    enqueueAttempts += 1;
    if (enqueueAttempts === 1)
      throw new Error("simulated outbox write failure");
    await readEvent(eventsRoot, trigger.id);
    existedWhenEnqueued = true;
    await enqueueDiscordEvent(afterRestart, trigger);
  });
  await watcher.start();
  for (
    let index = 0;
    (await eventExists(eventsRoot, "durable-immediate")) && index < 2_000;
    index += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  watcher.stop();
  assert.equal(
    enqueueAttempts,
    2,
    "a failed durable enqueue retries in process",
  );
  assert(existedWhenEnqueued, "the event file exists through durable enqueue");
  assert.equal(await eventExists(eventsRoot, "durable-immediate"), false);
  assert(
    await afterRestart.get(
      "discord:event:durable-immediate:2026-07-10T07:00:00.000Z",
    ),
    "the event record is durable before its source schedule is deleted",
  );
});

async function eventExists(root: string, id: string): Promise<boolean> {
  try {
    await readEvent(root, id);
    return true;
  } catch {
    return false;
  }
}

console.log("durable scheduled delivery verification passed");
