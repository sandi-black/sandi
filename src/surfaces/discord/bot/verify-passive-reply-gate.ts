import assert from "node:assert/strict";

import {
  PASSIVE_REPLY_DECISION_IGNORE,
  PASSIVE_REPLY_DECISION_RESPOND,
  PASSIVE_REPLY_GATE_INSTRUCTIONS,
  PASSIVE_REPLY_GATE_THINKING,
  PASSIVE_REPLY_GATE_TIMEOUT_MS,
  parsePassiveReplyGateDecision,
  passiveReplyGateRequestInput,
} from "@/surfaces/discord/bot/passive-reply-gate";

assert.equal(PASSIVE_REPLY_GATE_THINKING, "low");
assert.equal(PASSIVE_REPLY_DECISION_RESPOND, "RESPOND");
assert.equal(PASSIVE_REPLY_DECISION_IGNORE, "IGNORE");
assert.ok(PASSIVE_REPLY_GATE_TIMEOUT_MS > 0);
assert.match(PASSIVE_REPLY_GATE_INSTRUCTIONS, /passively reads/);
assert.match(PASSIVE_REPLY_GATE_INSTRUCTIONS, /Return exactly one word/);
assert.match(PASSIVE_REPLY_GATE_INSTRUCTIONS, /prefer IGNORE/);
assert.match(PASSIVE_REPLY_GATE_INSTRUCTIONS, /never reach you/);

// Decision parsing: explicit verdicts in either case, embedded in prose, and
// fail-quiet defaults for ambiguous or empty output.
assert.equal(parsePassiveReplyGateDecision("RESPOND"), true);
assert.equal(parsePassiveReplyGateDecision("IGNORE"), false);
assert.equal(parsePassiveReplyGateDecision("respond"), true);
assert.equal(parsePassiveReplyGateDecision("ignore"), false);
assert.equal(parsePassiveReplyGateDecision("RESPOND."), true);
assert.equal(parsePassiveReplyGateDecision("I would IGNORE this one"), false);
assert.equal(
  parsePassiveReplyGateDecision("Decision: RESPOND to the user"),
  true,
);
assert.equal(parsePassiveReplyGateDecision(""), false);
assert.equal(parsePassiveReplyGateDecision("maybe?"), false);
// "RESPONDED" must not match as a RESPOND verdict (word boundary).
assert.equal(parsePassiveReplyGateDecision("She RESPONDED earlier"), false);

const payload: unknown = JSON.parse(
  passiveReplyGateRequestInput({
    sandiName: "sandi",
    channelName: "general",
    author: { username: "jess", displayName: "Jess" },
    message: "does anyone know how to reset the router?",
    recentMessages: [
      { author: "Sam", content: "wifi is down again" },
      { author: "Jess", content: "ugh" },
    ],
  }),
);
assert(isRecord(payload));
assert.equal(
  payload["task"],
  "Decide whether Sandi should reply to the latest Discord message.",
);
assert.equal(payload["sandiName"], "sandi");
assert.equal(payload["channelName"], "general");
const latest = payload["latestMessage"];
assert(isRecord(latest));
assert.equal(latest["content"], "does anyone know how to reset the router?");
assert.equal(latest["replyingTo"], undefined);
const latestAuthor = latest["author"];
assert(isRecord(latestAuthor));
assert.equal(latestAuthor["username"], "jess");
assert.equal(latestAuthor["displayName"], "Jess");
const recentMessages = payload["recentMessages"];
assert(Array.isArray(recentMessages));
assert.equal(recentMessages.length, 2);

// A reply to another human is surfaced as replyingTo context.
const replyPayload: unknown = JSON.parse(
  passiveReplyGateRequestInput({
    sandiName: "sandi",
    channelName: "general",
    author: { username: "jess", displayName: "Jess" },
    message: "same here",
    repliedTo: { author: "Sam", content: "wifi is down again" },
    recentMessages: [],
  }),
);
assert(isRecord(replyPayload));
const replyLatest = replyPayload["latestMessage"];
assert(isRecord(replyLatest));
const replyingTo = replyLatest["replyingTo"];
assert(isRecord(replyingTo));
assert.equal(replyingTo["author"], "Sam");
assert.equal(replyingTo["content"], "wifi is down again");

console.log("Discord passive reply gate verification passed");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
