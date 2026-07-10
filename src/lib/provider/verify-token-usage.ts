import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatAccountTokenUsageRollups,
  formatTokenUsageRollups,
  readAccountTokenUsageRollups,
  readTokenUsageRollups,
} from "@/lib/provider/token-usage";
import { withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-token-usage-", async (tempRoot) => {
  const usagePath = join(tempRoot, "tokens.jsonl");
  await writeFile(
    usagePath,
    [
      record("2026-05-01T00:00:00.000Z", 1_000, 200, 50, 50),
      record("2026-05-20T00:00:00.000Z", 2_000, 300, 100, 0),
      record("2026-06-05T00:00:00.000Z", 3_000, 400, 0, 0, "primary"),
      record("2026-06-10T11:00:00.000Z", 4_000, 500, 0, 100, "secondary"),
      "",
    ].join("\n"),
    "utf8",
  );

  const rollups = await readTokenUsageRollups({
    path: usagePath,
    now: new Date("2026-06-10T12:00:00.000Z"),
  });

  assert.deepEqual(
    rollups.map((item) => ({
      label: item.label,
      total: item.totals.total,
      turns: item.turns,
    })),
    [
      { label: "lifetime", total: 11_700, turns: 4 },
      { label: "30d", total: 10_400, turns: 3 },
      { label: "7d", total: 8_000, turns: 2 },
      { label: "1d", total: 4_600, turns: 1 },
    ],
  );

  assert.deepEqual(
    await readTokenUsageRollups({ path: join(tempRoot, "none") }),
    [
      {
        label: "lifetime",
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
      },
      {
        label: "30d",
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
      },
      {
        label: "7d",
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
      },
      {
        label: "1d",
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        turns: 0,
      },
    ],
  );

  const formatted = formatTokenUsageRollups(rollups).join("\n");
  assert.match(formatted, /lifetime: 11\.7k total/);
  assert.match(formatted, /30d: 10\.4k total/);
  assert.match(formatted, /7d: 8k total/);
  assert.match(formatted, /1d: 4\.6k total/);

  const accountRollups = await readAccountTokenUsageRollups({
    path: usagePath,
    accounts: [
      { id: "primary", displayName: "Primary Human" },
      { id: "secondary", displayName: "Secondary Human" },
    ],
    now: new Date("2026-06-10T12:00:00.000Z"),
  });
  assert.deepEqual(
    accountRollups.map((item) => ({
      accountId: item.account.id,
      lifetime: item.rollups[0]?.totals.total,
      lastDay: item.rollups[3]?.totals.total,
    })),
    [
      { accountId: "primary", lifetime: 3_400, lastDay: 0 },
      { accountId: "secondary", lifetime: 4_600, lastDay: 4_600 },
    ],
  );
  const accountFormatted =
    formatAccountTokenUsageRollups(accountRollups).join("\n");
  assert.match(accountFormatted, /Primary Human:\n {2}- lifetime: 3\.4k total/);
  assert.match(
    accountFormatted,
    /Secondary Human:\n {2}- lifetime: 4\.6k total/,
  );

  console.log("token usage verification passed");
});

function record(
  timestamp: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  accountId?: string,
): string {
  const value = {
    v: 1,
    timestamp,
    accountId,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
  };
  return JSON.stringify(accountId ? value : { ...value, accountId: undefined });
}
