import { readFile } from "node:fs/promises";

import { z } from "zod/v4";

export type TokenUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type TokenUsageRollup = {
  label: "lifetime" | "30d" | "7d" | "1d";
  totals: TokenUsageTotals;
  turns: number;
};

export type TokenUsageAccount = {
  id: string;
  displayName?: string;
};

export type AccountTokenUsageRollups = {
  account: TokenUsageAccount;
  rollups: TokenUsageRollup[];
};

const EMPTY_TOTALS: TokenUsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

const TokenUsageRecordSchema = z.object({
  v: z.literal(1),
  timestamp: z.string().datetime(),
  accountId: z.string().optional(),
  usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

type TokenUsageRecord = z.infer<typeof TokenUsageRecordSchema>;

export async function readTokenUsageRollups(input: {
  path: string;
  now?: Date;
}): Promise<TokenUsageRollup[]> {
  const now = input.now ?? new Date();
  const records = await readTokenUsageRecords(input.path);
  return rollupsForRecords(records, now);
}

export async function readAccountTokenUsageRollups(input: {
  path: string;
  accounts: readonly TokenUsageAccount[];
  now?: Date;
}): Promise<AccountTokenUsageRollups[]> {
  const now = input.now ?? new Date();
  const records = await readTokenUsageRecords(input.path);
  return input.accounts.map((account) => ({
    account,
    rollups: rollupsForRecords(
      records.filter((record) => recordAccountId(record) === account.id),
      now,
    ),
  }));
}

function rollupsForRecords(
  records: readonly TokenUsageRecord[],
  now: Date,
): TokenUsageRollup[] {
  return [
    rollup("lifetime", records),
    rollup("30d", recordsSince(records, now, 30)),
    rollup("7d", recordsSince(records, now, 7)),
    rollup("1d", recordsSince(records, now, 1)),
  ];
}

export function formatTokenUsageRollups(
  rollups: readonly TokenUsageRollup[],
): string[] {
  if (rollups.every((item) => item.turns === 0)) {
    return ["Tokens: no recorded usage yet"];
  }

  return [
    "Tokens:",
    ...rollups.map(
      (item) =>
        `- ${item.label}: ${formatTokens(item.totals.total)} total (${formatTokens(item.totals.input)} in, ${formatTokens(item.totals.output)} out${formatCacheUsage(item.totals)}; ${item.turns.toLocaleString()} ${item.turns === 1 ? "turn" : "turns"})`,
    ),
  ];
}

export function formatAccountTokenUsageRollups(
  rollupsByAccount: readonly AccountTokenUsageRollups[],
): string[] {
  if (rollupsByAccount.length === 0) return ["Tokens: no configured accounts"];
  return [
    "Tokens:",
    ...rollupsByAccount.flatMap((item) => [
      `- ${accountLabel(item.account)}:`,
      ...item.rollups.map(
        (rollup) => `  - ${rollup.label}: ${formatRollupUsage(rollup)}`,
      ),
    ]),
  ];
}

async function readTokenUsageRecords(
  path: string,
): Promise<TokenUsageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const records: TokenUsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value = parseJsonLine(trimmed);
    if (!value) continue;
    const parsed = TokenUsageRecordSchema.safeParse(value);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function recordsSince(
  records: readonly TokenUsageRecord[],
  now: Date,
  days: number,
): TokenUsageRecord[] {
  const minTime = now.getTime() - days * 86_400_000;
  return records.filter(
    (record) => new Date(record.timestamp).getTime() >= minTime,
  );
}

function rollup(
  label: TokenUsageRollup["label"],
  records: readonly TokenUsageRecord[],
): TokenUsageRollup {
  const totals = { ...EMPTY_TOTALS };
  for (const record of records) {
    totals.input += record.usage.input;
    totals.output += record.usage.output;
    totals.cacheRead += record.usage.cacheRead;
    totals.cacheWrite += record.usage.cacheWrite;
    totals.total += record.usage.total;
  }
  return { label, totals, turns: records.length };
}

function formatRollupUsage(item: TokenUsageRollup): string {
  if (item.turns === 0) return "0 tokens (0 turns)";
  return `${formatTokens(item.totals.total)} total (${formatTokens(item.totals.input)} in, ${formatTokens(item.totals.output)} out${formatCacheUsage(item.totals)}; ${item.turns.toLocaleString()} ${item.turns === 1 ? "turn" : "turns"})`;
}

function recordAccountId(record: TokenUsageRecord): string {
  return record.accountId ?? "default";
}

function accountLabel(account: TokenUsageAccount): string {
  return account.displayName ?? account.id;
}

function formatCacheUsage(totals: TokenUsageTotals): string {
  const cache = totals.cacheRead + totals.cacheWrite;
  if (cache === 0) return "";
  return `, ${formatTokens(cache)} cache`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${formatShortNumber(value / 1_000)}k`;
  if (value < 1_000_000_000) return `${formatShortNumber(value / 1_000_000)}M`;
  return `${formatShortNumber(value / 1_000_000_000)}B`;
}

function formatShortNumber(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
