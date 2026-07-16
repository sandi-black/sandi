import assert from "node:assert/strict";

import {
  countReplyChainUpTo,
  defaultTopLevelEngagementRoute,
  requestedTopLevelEngagementRoute,
  resolveTopLevelEngagementRoute,
  TOP_LEVEL_RESPONSE_ROUTE_SIGNAL,
  TOP_LEVEL_THREAD_SUGGESTION_LENGTH,
  topLevelEngagementInstructions,
} from "@/surfaces/discord/bot/top-level-engagement";

assert.equal(defaultTopLevelEngagementRoute("@Sandi hello"), "inline");
assert.equal(
  defaultTopLevelEngagementRoute("@Sandi :thread: let's dig into this"),
  "thread",
);
assert.equal(
  defaultTopLevelEngagementRoute("@Sandi <:thread:123456789> let's dig in"),
  "thread",
);
assert.equal(
  defaultTopLevelEngagementRoute("@Sandi <a:thread:123456789> animated"),
  "thread",
);
assert.equal(
  defaultTopLevelEngagementRoute("look at foo:thread:bar"),
  "inline",
);
assert.equal(
  defaultTopLevelEngagementRoute("please :thread:, thanks"),
  "thread",
);

assert.equal(
  resolveTopLevelEngagementRoute({ defaultRoute: "inline" }),
  "inline",
);
assert.equal(requestedTopLevelEngagementRoute([]), undefined);
assert.equal(
  requestedTopLevelEngagementRoute([
    { kind: TOP_LEVEL_RESPONSE_ROUTE_SIGNAL, value: "thread" },
  ]),
  "thread",
);
assert.equal(
  requestedTopLevelEngagementRoute([
    { kind: TOP_LEVEL_RESPONSE_ROUTE_SIGNAL, value: "thread" },
    { kind: "unrelated", value: "ignored" },
    { kind: TOP_LEVEL_RESPONSE_ROUTE_SIGNAL, value: "inline" },
  ]),
  "inline",
);
assert.equal(
  requestedTopLevelEngagementRoute([
    { kind: TOP_LEVEL_RESPONSE_ROUTE_SIGNAL, value: "invalid" },
  ]),
  undefined,
);
assert.equal(
  resolveTopLevelEngagementRoute({
    defaultRoute: "inline",
    requestedRoute: "thread",
  }),
  "thread",
);
assert.equal(
  resolveTopLevelEngagementRoute({
    defaultRoute: "thread",
    requestedRoute: "inline",
  }),
  "inline",
);

const shortChainInstructions = topLevelEngagementInstructions({
  defaultRoute: "inline",
  replyChainLength: TOP_LEVEL_THREAD_SUGGESTION_LENGTH - 1,
});
assert.match(shortChainInstructions, /default is to reply inline/);
assert.match(shortChainInstructions, /discord_route_response/);
assert.match(shortChainInstructions, /Omit the tool call/);
assert.doesNotMatch(shortChainInstructions, /Consider creating a thread/);

const longChainInstructions = topLevelEngagementInstructions({
  defaultRoute: "inline",
  replyChainLength: TOP_LEVEL_THREAD_SUGGESTION_LENGTH,
});
assert.match(longChainInstructions, /at least 4 messages long/);
assert.match(longChainInstructions, /Consider creating a thread/);

const requestedThreadInstructions = topLevelEngagementInstructions({
  defaultRoute: "thread",
  replyChainLength: 1,
});
assert.match(requestedThreadInstructions, /contains the :thread: emoji/);

const replyChain = new Map([
  ["message-4", { id: "message-4", referencedMessageId: "message-3" }],
  ["message-3", { id: "message-3", referencedMessageId: "message-2" }],
  ["message-2", { id: "message-2", referencedMessageId: "message-1" }],
  ["message-1", { id: "message-1" }],
]);
const fetchReplyChainMessage = async (messageId: string) => {
  const message = replyChain.get(messageId);
  if (!message) throw new Error(`missing reply-chain message ${messageId}`);
  return message;
};
const replyChainStart = replyChain.get("message-4");
assert(replyChainStart);
assert.equal(
  await countReplyChainUpTo({
    start: replyChainStart,
    maximumLength: TOP_LEVEL_THREAD_SUGGESTION_LENGTH,
    fetchReferencedMessage: fetchReplyChainMessage,
  }),
  4,
);
await assert.rejects(
  countReplyChainUpTo({
    start: { id: "message-5", referencedMessageId: "missing" },
    maximumLength: TOP_LEVEL_THREAD_SUGGESTION_LENGTH,
    fetchReferencedMessage: fetchReplyChainMessage,
  }),
  /missing reply-chain message/,
);

console.log("Discord top-level engagement verification passed");
