import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isUnknownDiscordMessageError,
  pruneReminderMessageRefs,
} from "@/surfaces/discord/reminders/message-refs";
import type { Reminder } from "@/surfaces/discord/reminders/schemas";
import {
  readReminder,
  writeReminder,
} from "@/surfaces/discord/reminders/store";

const root = await mkdtemp(join(tmpdir(), "sandi-reminder-message-refs-"));

try {
  const reminder = sampleReminder();
  await writeReminder(root, "test-reminder", reminder);

  assert.equal(isUnknownDiscordMessageError({ code: 10_008 }), true);
  assert.equal(isUnknownDiscordMessageError({ code: 50_013 }), false);
  assert.equal(
    isUnknownDiscordMessageError(new Error("Unknown Message")),
    false,
  );

  await pruneReminderMessageRefs(root, "test-reminder", [
    { channelId: "channel-1", messageId: "message-1" },
    { channelId: "channel-1", messageId: "already-absent" },
  ]);

  const updated = await readReminder(root, "test-reminder");
  assert.deepEqual(updated.messageRefs, [
    { channelId: "channel-1", messageId: "message-2" },
  ]);

  const persisted = await readFile(join(root, "test-reminder.json"), "utf8");
  assert.equal(persisted.includes("message-1"), false);
  assert.equal(persisted.includes("message-2"), true);

  console.log("reminder message ref verification passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

function sampleReminder(): Reminder {
  return {
    target: { kind: "channel", channelId: "channel-1" },
    text: "Test reminder",
    createdAt: "2026-07-24T00:00:00.000Z",
    audienceUserIds: [],
    status: "active",
    nextFireAt: "2026-07-25T00:00:00.000Z",
    followupIntervalMinutes: 60,
    fireCount: 2,
    messageRefs: [
      { channelId: "channel-1", messageId: "message-1" },
      { channelId: "channel-1", messageId: "message-2" },
    ],
  };
}
