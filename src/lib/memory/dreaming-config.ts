import { readEnv } from "@/lib/config/env";

// How automatic memory consolidation is paced. Short-term encoding fires after a
// conversation has been quiet for idleMs; the deeper overnight dream runs on
// nightlyCron. Everything has a sensible default so the feature works with no
// configuration, and can be turned off entirely.
export type DreamingConfig = {
  enabled: boolean;
  idleMs: number;
  nightlyCron: string;
  timezone: string;
  transcriptCharBudget: number;
};

const DEFAULT_IDLE_MINUTES = 10;
const DEFAULT_NIGHTLY_CRON = "0 4 * * *";
const DEFAULT_TRANSCRIPT_CHARS = 24_000;

export function loadDreamingConfig(): DreamingConfig {
  return {
    enabled: readBooleanEnv(["SANDI_DREAMING_ENABLED"], true),
    idleMs:
      readPositiveIntEnv(
        ["SANDI_DREAMING_IDLE_MINUTES"],
        DEFAULT_IDLE_MINUTES,
      ) *
      60 *
      1_000,
    nightlyCron:
      readEnv(["SANDI_DREAMING_NIGHTLY_CRON"]) ?? DEFAULT_NIGHTLY_CRON,
    timezone: readEnv(["SANDI_DREAMING_TIMEZONE", "TZ"]) ?? "UTC",
    transcriptCharBudget: readPositiveIntEnv(
      ["SANDI_DREAMING_TRANSCRIPT_CHARS"],
      DEFAULT_TRANSCRIPT_CHARS,
    ),
  };
}

function readPositiveIntEnv(
  names: readonly string[],
  defaultValue: number,
): number {
  const value = readEnv(names);
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${names[0]} must be a positive integer`);
  }
  return parsed;
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
