import { Cron } from "croner";

import { readEnv } from "@/lib/config/env";

// How automatic memory consolidation is paced. Short-term encoding fires after a
// conversation has been quiet for idleMs; the deeper overnight dream runs on
// nightlyCron. Everything has a sensible default so the feature works with no
// configuration, and can be turned off entirely. Every value is validated at the
// env boundary so an invalid setting fails loudly at startup rather than deep in
// the scheduler.
export type DreamingConfig = {
  enabled: boolean;
  idleMs: number;
  nightlyCron: string;
  timezone: string;
  transcriptCharBudget: number;
};

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_NIGHTLY_CRON = "0 4 * * *";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_TRANSCRIPT_CHARS = 24_000;

export function loadDreamingConfig(): DreamingConfig {
  const idleMinutes = readStrictPositiveInt(
    "SANDI_DREAMING_IDLE_MINUTES",
    DEFAULT_IDLE_MINUTES,
  );
  return {
    enabled: readBooleanEnv(["SANDI_DREAMING_ENABLED"], true),
    idleMs: idleMinutes * 60 * 1_000,
    nightlyCron: parseCron(
      readEnv(["SANDI_DREAMING_NIGHTLY_CRON"]) ?? DEFAULT_NIGHTLY_CRON,
    ),
    timezone: parseTimezone(
      readEnv(["SANDI_DREAMING_TIMEZONE", "TZ"]) ?? DEFAULT_TIMEZONE,
    ),
    transcriptCharBudget: readStrictPositiveInt(
      "SANDI_DREAMING_TRANSCRIPT_CHARS",
      DEFAULT_TRANSCRIPT_CHARS,
    ),
  };
}

// Accepts only a base-10 positive integer; "10abc", "1.5", and "0" are rejected
// rather than silently coerced.
function readStrictPositiveInt(name: string, defaultValue: number): number {
  const value = readEnv([name]);
  if (!value) return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

// Rejects an invalid cron expression at load time by constructing a paused Cron,
// which parses the pattern without scheduling anything.
function parseCron(value: string): string {
  try {
    new Cron(value, { paused: true }).stop();
  } catch {
    throw new Error(
      `SANDI_DREAMING_NIGHTLY_CRON is not a valid cron expression: ${value}`,
    );
  }
  return value;
}

// Rejects an unknown IANA time zone; Intl throws a RangeError for an invalid one.
function parseTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(
      `SANDI_DREAMING_TIMEZONE is not a valid IANA time zone: ${value}`,
    );
  }
  return value;
}

function readBooleanEnv(
  names: readonly string[],
  defaultValue: boolean,
): boolean {
  const value = readEnv(names);
  if (!value) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`${names[0]} must be true or false`);
}
