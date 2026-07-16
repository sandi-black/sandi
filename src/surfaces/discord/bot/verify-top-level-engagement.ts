import assert from "node:assert/strict";

import { topLevelEngagementRoute } from "@/surfaces/discord/bot/top-level-engagement";

assert.equal(
  topLevelEngagementRoute({
    isReplyToSandi: true,
    isInlineReplyChannel: false,
  }),
  "inline",
);
assert.equal(
  topLevelEngagementRoute({
    isReplyToSandi: false,
    isInlineReplyChannel: true,
  }),
  "inline",
);
assert.equal(
  topLevelEngagementRoute({
    isReplyToSandi: false,
    isInlineReplyChannel: false,
  }),
  "thread",
);

console.log("Discord top-level engagement verification passed");
