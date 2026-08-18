import assert from "node:assert/strict";
import { join } from "node:path";

import type { MessageCreateOptions } from "discord.js";

import { DurableOutbox } from "@/lib/delivery/outbox";
import {
  type OpenAIUsageSnapshot,
  type OpenAIUsageWindow,
  parseOpenAIUsageResponse,
} from "@/lib/provider/openai-usage";
import type { ProviderTurnResponse } from "@/lib/provider/pi-cli-client";
import { withTempDir } from "@/lib/verification/harness";
import { registerDiscordMessageDelivery } from "@/surfaces/discord/bot/delivery-outbox";
import {
  enqueueStandaloneUsageWarning,
  type PreparedUsageWarning,
  UsageThresholdWarning,
} from "@/surfaces/discord/bot/usage-threshold-warning";

const parsedUsage = parseOpenAIUsageResponse({
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
    },
    secondary_window: null,
  },
});
assert.equal(parsedUsage.available, true);
assert.equal(
  parsedUsage.available ? parsedUsage.windows.length : undefined,
  1,
  "a null secondary usage window is treated as absent",
);

await withTempDir("sandi-usage-threshold-", async (dataDir) => {
  let current = usage(95, 95);
  const notices: string[] = [];
  const createWarning = (root: string): UsageThresholdWarning =>
    new UsageThresholdWarning({
      dataDir: root,
      accounts: [{ id: "primary" }],
      readUsage: async () => current,
    });
  const warning = createWarning(dataDir);

  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 0, "95% remaining stays quiet");

  current = usage(89, 95);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 1, "entering the 80% 5h block warns once");
  assert.match(notices[0] ?? "", /5h 89% remaining/u);
  assert.match(notices[0] ?? "", /week 95% remaining/u);

  current = usage(87, 95);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 1, "usage within the same block stays quiet");

  current = usage(79, 94);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 2, "entering the next 5h block warns again");

  current = usage(78, 89);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 3, "the weekly window triggers independently");
  assert.match(notices[2] ?? "", /5h 78% remaining/u);
  assert.match(notices[2] ?? "", /week 89% remaining/u);

  current = usage(77, 87);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 3, "both unchanged blocks stay quiet");

  current = usage(85, 86);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 3, "a limit increase resets without warning");

  current = usage(84, 85);
  await observe(warning, notices, "ada", "primary");
  assert.equal(notices.length, 4, "the reset window can warn in its new cycle");

  const restarted = createWarning(dataDir);
  await observe(restarted, notices, "ada", "primary");
  assert.equal(
    notices.length,
    4,
    "persisted state prevents restart duplicates",
  );

  await observe(restarted, notices, "grace", "primary");
  assert.equal(notices.length, 5, "notification blocks are per Discord user");

  let unavailableReads = 0;
  const unrouted = new UsageThresholdWarning({
    dataDir: join(dataDir, "unrouted"),
    accounts: [{ id: "primary" }],
    readUsage: async () => {
      unavailableReads += 1;
      return current;
    },
  });
  const unroutedResponse = turnResponse("unchanged");
  const unroutedPrepared = await unrouted.prepare({
    discordUserId: "anna",
    accountId: "unknown",
    response: unroutedResponse,
  });
  assert.equal(
    unavailableReads,
    0,
    "unknown routes do not read another account",
  );
  assert.equal(unroutedPrepared.response, unroutedResponse);

  current = usage(89, 95);
  const sideEffectWarning = createWarning(join(dataDir, "side-effect"));
  const sideEffectResponse = turnResponse("", true);
  const sideEffectPrepared = await sideEffectWarning.prepare({
    discordUserId: "winlock",
    accountId: "primary",
    response: sideEffectResponse,
  });
  assert.equal(sideEffectPrepared.response, sideEffectResponse);
  assert.match(
    sideEffectPrepared.standaloneContent ?? "",
    /^-# OpenAI usage:/u,
    "tool-only turns get a standalone public reply",
  );

  const failing = new UsageThresholdWarning({
    dataDir: join(dataDir, "failed-read"),
    accounts: [{ id: "primary" }],
    readUsage: async () => {
      throw new Error("usage endpoint failed");
    },
  });
  const failedResponse = turnResponse("still delivered");
  const failedPrepared = await failing.prepare({
    discordUserId: "lovelace",
    accountId: "primary",
    response: failedResponse,
  });
  assert.equal(
    failedPrepared.response,
    failedResponse,
    "usage failures do not alter the chat response",
  );

  const warningOutbox = new DurableOutbox(join(dataDir, "warning-outbox.json"));
  const sentWarnings: MessageCreateOptions[] = [];
  registerDiscordMessageDelivery(warningOutbox, async (_channelId, options) => {
    sentWarnings.push(options);
    return { id: `warning-${sentWarnings.length}` };
  });
  await enqueueStandaloneUsageWarning({
    outbox: warningOutbox,
    channelId: "123",
    messageId: "456",
    content: "ordinary warning",
  });
  await enqueueStandaloneUsageWarning({
    outbox: warningOutbox,
    channelId: "123",
    messageId: "event:nightly-review:2026-08-17T09:00:00.000Z",
    content: "scheduled warning",
  });
  assert.equal(
    sentWarnings[0]?.reply?.messageReference,
    "456",
    "ordinary turns keep their reply target",
  );
  assert.equal(
    sentWarnings[1]?.reply,
    undefined,
    "synthetic scheduled-event ids are sent without an invalid reply target",
  );
});

console.log("usage threshold warning verification passed");

async function observe(
  warning: UsageThresholdWarning,
  notices: string[],
  discordUserId: string,
  accountId: string,
): Promise<PreparedUsageWarning> {
  const prepared = await warning.prepare({
    discordUserId,
    accountId,
    response: turnResponse("Sandi response"),
  });
  const notice =
    prepared.standaloneContent ?? footerFrom(prepared.response.text);
  if (notice) notices.push(notice);
  return prepared;
}

function footerFrom(content: string): string | undefined {
  const marker = "-# OpenAI usage:";
  const index = content.indexOf(marker);
  return index < 0 ? undefined : content.slice(index);
}

function turnResponse(
  text: string,
  deliverySideEffects = false,
): ProviderTurnResponse {
  return {
    text,
    deliverySideEffects,
    signals: [],
    raw: {},
  };
}

function usage(
  fiveHourRemaining: number,
  weeklyRemaining: number,
): OpenAIUsageSnapshot {
  return {
    available: true,
    windows: [
      usageWindow("five-hour", 18_000, fiveHourRemaining, 3_600),
      usageWindow("weekly", 604_800, weeklyRemaining, 86_400),
    ],
  };
}

function usageWindow(
  kind: OpenAIUsageWindow["kind"],
  windowSeconds: number,
  remainingPercent: number,
  resetAfterSeconds: number,
): OpenAIUsageWindow {
  return {
    kind,
    windowSeconds,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetAfterSeconds,
  };
}
