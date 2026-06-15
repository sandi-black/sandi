import { type CoreConfig, loadCoreConfig, readEnv } from "@/lib/config/env";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_NOTIFICATIONS = 50;
const DEFAULT_NOTIFICATION_REASONS = ["mention", "review_requested"];

export type GitHubConfig = {
  ghCommand: string;
  login?: string;
  pollIntervalMs: number;
  maxNotificationsPerPoll: number;
  notificationReasons: string[];
  processExistingNotifications: boolean;
};

export type GitHubAppConfig = CoreConfig & {
  github: GitHubConfig;
};

export function loadGitHubConfig(): GitHubConfig {
  const login = readEnv(["SANDI_GITHUB_LOGIN", "GITHUB_LOGIN"]);
  const config: GitHubConfig = {
    ghCommand: readEnv(["SANDI_GH_COMMAND", "GH_COMMAND"]) ?? "gh",
    pollIntervalMs: readPositiveIntegerEnv(
      ["SANDI_GITHUB_POLL_INTERVAL_MS"],
      DEFAULT_POLL_INTERVAL_MS,
    ),
    maxNotificationsPerPoll: readPositiveIntegerEnv(
      ["SANDI_GITHUB_MAX_NOTIFICATIONS"],
      DEFAULT_MAX_NOTIFICATIONS,
    ),
    notificationReasons:
      readCsvEnv(["SANDI_GITHUB_NOTIFICATION_REASONS"]) ??
      DEFAULT_NOTIFICATION_REASONS,
    processExistingNotifications: readBooleanEnv(
      ["SANDI_GITHUB_PROCESS_EXISTING_NOTIFICATIONS"],
      false,
    ),
  };
  if (login) config.login = login;
  return config;
}

export function loadGitHubAppConfig(): GitHubAppConfig {
  return {
    ...loadCoreConfig(),
    github: loadGitHubConfig(),
  };
}

function readPositiveIntegerEnv(
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

function readCsvEnv(names: readonly string[]): string[] | undefined {
  const value = readEnv(names);
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
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
