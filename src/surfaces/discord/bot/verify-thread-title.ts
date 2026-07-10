import assert from "node:assert/strict";

import { isRecord } from "@/lib/verification/harness";
import {
  DISCORD_THREAD_TITLE_MAX_LENGTH,
  MENTION_THREAD_PLACEHOLDER_TITLE,
  MENTION_THREAD_TITLE_THINKING,
  normalizeGeneratedThreadTitle,
  THREAD_TITLE_INSTRUCTIONS,
  threadTitleRequestInput,
} from "@/surfaces/discord/bot/thread-title";

assert.equal(MENTION_THREAD_TITLE_THINKING, "low");
assert.match(THREAD_TITLE_INSTRUCTIONS, /Return exactly one title/);
assert.match(THREAD_TITLE_INSTRUCTIONS, /no wrapping quotes/);
assert.match(THREAD_TITLE_INSTRUCTIONS, /under 100 characters/);

assert.equal(
  normalizeGeneratedThreadTitle('"Deploy Checklist Help"'),
  "Deploy Checklist Help",
);
assert.equal(
  normalizeGeneratedThreadTitle("Title: dinner plan tweaks."),
  "dinner plan tweaks",
);
assert.equal(
  normalizeGeneratedThreadTitle("\n\nBug triage from logs\nextra text"),
  "Bug triage from logs",
);
assert.equal(normalizeGeneratedThreadTitle(" \n\t "), undefined);

const longTitle = normalizeGeneratedThreadTitle("x".repeat(140));
assert(longTitle);
assert.equal(longTitle.length, DISCORD_THREAD_TITLE_MAX_LENGTH);
assert(longTitle.endsWith("..."));

const request: unknown = JSON.parse(
  threadTitleRequestInput({
    authorUsername: "jess",
    channelName: "ops",
    message: "Can you help me debug these deployment logs?",
  }),
);
assert(isRecord(request));
assert.equal(
  request["task"],
  "Generate a Discord thread title for this Sandi conversation.",
);
const author = request["author"];
assert(isRecord(author));
assert.equal(author["username"], "jess");
assert.equal(author["displayName"], "jess");
assert.equal(request["channelName"], "ops");
assert.equal(
  request["userMessage"],
  "Can you help me debug these deployment logs?",
);
assert.equal(MENTION_THREAD_PLACEHOLDER_TITLE, "new thread");

console.log("Discord thread title verification passed");
