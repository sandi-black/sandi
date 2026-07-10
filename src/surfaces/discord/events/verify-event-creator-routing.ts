import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, withTempDir } from "@/lib/verification/harness";
import { readEvent, resolveEventPath } from "@/surfaces/discord/events/store";
import { createEvent } from "@/surfaces/discord/runtime/events";

await withTempDir("sandi-event-creator-", async (tempRoot) => {
  const eventsRoot = join(tempRoot, "events");
  process.env["SANDI_EVENTS_ROOT"] = eventsRoot;
  process.env["SANDI_PLATFORM_CONTEXT"] = JSON.stringify({
    platform: "discord",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "message-1",
    author: {
      discordUserId: "discord-user-1",
      username: "casey-discord",
      displayName: "Casey",
      identityId: "casey",
    },
  });

  const created = await createEvent({
    id: "creator-routing",
    type: "one-shot",
    text: "Check that the creator account owns this scheduled turn.",
    at: "2026-06-09T18:00:00.000Z",
  });
  assert(
    created.event.createdBy.identityId === "casey",
    "created event should store the mapped creator identity",
  );
  assert(
    created.event.createdBy.discordUserId === "discord-user-1",
    "created event should store the creator Discord user id",
  );

  const persisted = await readEvent(eventsRoot, "creator-routing");
  assert(
    persisted.createdBy.identityId === "casey",
    "persisted event should retain creator identity",
  );

  delete process.env["SANDI_PLATFORM_CONTEXT"];
  await assertRejects(
    () =>
      createEvent({
        id: "missing-author-context",
        type: "immediate",
        text: "This should not be schedulable without an accountable creator.",
      }),
    "event creation without Discord author context should fail",
  );

  const creatorlessPath = resolveEventPath(eventsRoot, "creatorless");
  await mkdir(eventsRoot, { recursive: true });
  await writeFile(
    creatorlessPath,
    `${JSON.stringify(
      {
        type: "immediate",
        target: { kind: "channel", channelId: "channel-1" },
        text: "Creatorless event JSON must be invalid.",
        createdAt: "2026-06-09T18:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await assertRejects(
    () => readEvent(eventsRoot, "creatorless"),
    "creatorless event JSON should fail schema validation",
  );

  console.log("event creator routing verification passed");
});

async function assertRejects(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}
