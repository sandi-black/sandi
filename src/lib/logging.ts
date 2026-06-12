export type LogFields = Record<string, unknown>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export function createLogger(scope: string): Logger {
  return {
    info(message, fields) {
      writeLog("info", scope, message, fields);
    },
    warn(message, fields) {
      writeLog("warn", scope, message, fields);
    },
    error(message, fields) {
      writeLog("error", scope, message, fields);
    },
  };
}

function writeLog(
  level: "info" | "warn" | "error",
  scope: string,
  message: string,
  fields?: LogFields,
): void {
  const payload = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
