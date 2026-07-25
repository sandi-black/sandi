import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationStore } from "@/lib/conversations/store";
import type { ConversationParticipant } from "@/lib/conversations/types";
import {
  buildDiscordThreadManifest,
  type DiscordThreadConversationSource,
  discordConversationStorageId,
  withDiscordSurfacePrompt,
} from "@/surfaces/discord/discord/conversations";

const starter: ConversationParticipant = {
  platform: "discord",
  platformUserId: "user-1",
  username: "Jess",
  joinedAt: "2026-06-14T00:00:00.000Z",
};

const messageThreadSource: DiscordThreadConversationSource = {
  kind: "message_thread",
  originChannelId: "channel-1",
  originMessageId: "message-1",
  originMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
  starterMessage: "please help with this",
  createdByUserId: "user-1",
};

const messageThreadManifest = buildDiscordThreadManifest({
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: "thread-1",
  title: "please help with this",
  starter,
  source: messageThreadSource,
});

assert.equal(discordConversationStorageId(messageThreadManifest), "thread-1");
assert.equal(messageThreadManifest.memoryScopes.length, 1);
assert.equal(
  messageThreadManifest.memoryScopes[0]?.refPrefix,
  "surfaces/discord/threads/thread-1",
);
assert.equal(messageThreadManifest.memoryScopes[0]?.area, "current_thread");
assert.match(
  messageThreadManifest.surfacePrompt ?? "",
  /top-level channel mention/,
);
assert.match(messageThreadManifest.surfacePrompt ?? "", /whole Pi session/);
assert.doesNotMatch(
  messageThreadManifest.memoryScopes.map((scope) => scope.label).join("\n"),
  /Parent Channel Room/,
);

const restoredMessageThreadManifest = withDiscordSurfacePrompt({
  ...messageThreadManifest,
  surfacePrompt: undefined,
});
assert.match(
  restoredMessageThreadManifest.surfacePrompt ?? "",
  /top-level channel mention/,
);

const branchSource: DiscordThreadConversationSource = {
  kind: "channel_branch",
  parentConversationId: "discord:guild-1:channel-1:room",
  originChannelId: "channel-1",
  originMessageId: "message-2",
  originMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-2",
  starterMessage: "old branch",
  bridgeSummary: "Branched from #general",
  createdByUserId: "user-1",
};

const branchManifest = buildDiscordThreadManifest({
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: "thread-2",
  title: "old branch",
  starter,
  source: branchSource,
});

assert.equal(branchManifest.memoryScopes.length, 2);
assert.equal(branchManifest.memoryScopes[1]?.label, "Parent Channel Room");

const dataDir = await mkdtemp(join(tmpdir(), "sandi-conversation-store-"));
try {
  const store = new ConversationStore(dataDir);
  const created = await store.getOrCreate({
    storageId: "thread-1",
    fallback: messageThreadManifest,
  });
  assert.deepEqual(await store.get("thread-1"), created);
  assert.deepEqual(await store.list(), [created]);

  const existing = await store.getOrCreate({
    storageId: "thread-1",
    fallback: { ...messageThreadManifest, title: "Replacement fallback" },
  });
  assert.equal(existing.title, messageThreadManifest.title);

  const applied = await store.applyManaged({
    storageId: "thread-2",
    fallback: branchManifest,
    mutate: (current) => current,
  });
  assert.deepEqual(await store.get("thread-2"), applied);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("Discord conversation verification passed");
