import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord, withTempDir } from "@/lib/verification/harness";
import {
  appendIgnoredConversationChannel,
  IGNORED_CHANNELS_PATH,
  loadIgnoredConversationChannels,
  removeIgnoredConversationChannel,
} from "@/surfaces/discord/bot/ignored-channels";

await withTempDir("sandi-ignored-channels-", async (dataDir) => {
  // A missing file means nothing is ignored.
  const empty = await loadIgnoredConversationChannels(dataDir);
  assert.equal(empty.size, 0);

  // Appending creates the file and round-trips the ID.
  const afterFirst = await appendIgnoredConversationChannel(dataDir, "111");
  assert.deepEqual([...afterFirst], ["111"]);
  const reloaded = await loadIgnoredConversationChannels(dataDir);
  assert.deepEqual([...reloaded], ["111"]);

  // The persisted file matches the documented shape.
  const filePath = join(dataDir, IGNORED_CHANNELS_PATH);
  const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assert(isRecord(persisted));
  assert.deepEqual(persisted["channels"], [{ id: "111" }]);

  // Adding a second ID keeps the first; re-adding an existing ID is idempotent.
  await appendIgnoredConversationChannel(dataDir, "222");
  const afterDuplicate = await appendIgnoredConversationChannel(dataDir, "111");
  assert.deepEqual([...afterDuplicate].sort(), ["111", "222"]);
  const finalSet = await loadIgnoredConversationChannels(dataDir);
  assert.equal(finalSet.size, 2);
  assert(finalSet.has("111"));
  assert(finalSet.has("222"));

  // Removing a present ID rewrites the file and reports it was removed.
  const removeHit = await removeIgnoredConversationChannel(dataDir, "111");
  assert.equal(removeHit.removed, true);
  assert.deepEqual([...removeHit.channels], ["222"]);
  const afterRemove = await loadIgnoredConversationChannels(dataDir);
  assert.deepEqual([...afterRemove], ["222"]);

  // Removing an absent ID is a no-op that reports nothing was removed.
  const removeMiss = await removeIgnoredConversationChannel(dataDir, "999");
  assert.equal(removeMiss.removed, false);
  assert.deepEqual([...removeMiss.channels], ["222"]);

  // Invalid configs are ignored rather than throwing.
  await writeFile(filePath, JSON.stringify({ channels: "nope" }), "utf8");
  const invalid = await loadIgnoredConversationChannels(dataDir);
  assert.equal(invalid.size, 0);

  // Non-numeric IDs are rejected by the validator.
  await writeFile(
    filePath,
    JSON.stringify({ channels: [{ id: "not-a-snowflake" }] }),
    "utf8",
  );
  const nonNumeric = await loadIgnoredConversationChannels(dataDir);
  assert.equal(nonNumeric.size, 0);

  console.log("Discord ignored channels verification passed");
});
