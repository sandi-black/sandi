import {
  type CoreConfig,
  loadCoreConfig,
  readBooleanEnv,
  readCsvEnv,
  readEnv,
  readNumberEnv,
} from "@/lib/config/env";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_NOTIFICATIONS = 50;
const DEFAULT_NOTIFICATION_REASONS = ["mention", "review_requested"];
const DEFAULT_GH_TIMEOUT_MS = 120_000;

export type GitHubConfig = {
  ghCommand: string;
  login?: string;
  pollIntervalMs: number;
  ghTimeoutMs: number;
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
    pollIntervalMs: readNumberEnv(
      ["SANDI_GITHUB_POLL_INTERVAL_MS"],
      DEFAULT_POLL_INTERVAL_MS,
    ),
    ghTimeoutMs: readNumberEnv(["SANDI_GH_TIMEOUT_MS"], DEFAULT_GH_TIMEOUT_MS),
    maxNotificationsPerPoll: readNumberEnv(
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
