import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendIgnoredConversationChannel,
  IGNORED_CHANNELS_PATH,
  loadIgnoredConversationChannels,
} from "@/surfaces/discord/bot/ignored-channels";

const dataDir = await mkdtemp(join(tmpdir(), "sandi-ignored-channels-"));

try {
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
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
