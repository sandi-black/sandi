export function protectedEnvironmentValues(
  env: Record<string, string> | undefined,
): string[] {
  return [
    ...new Set(Object.values(env ?? {}).filter((value) => value.length > 0)),
  ].sort((left, right) => right.length - left.length);
}

export function redactText(text: string, protectedValues: string[]): string {
  let redacted = text;
  for (const value of protectedValues) {
    redacted = redacted.replaceAll(value, "[redacted]");
  }
  return redacted;
}

export function redactValue(
  value: unknown,
  protectedValues: string[],
): unknown {
  if (typeof value === "string") return redactText(value, protectedValues);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, protectedValues));
  }
  if (typeof value !== "object" || value === null) return value;
  const imageData = "data" in value ? value.data : undefined;
  if (
    "type" in value &&
    value.type === "image" &&
    typeof imageData === "string" &&
    protectedValues.some((protectedValue) => imageData.includes(protectedValue))
  ) {
    throw new Error(
      "desktop MCP image contained a protected environment value",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactText(key, protectedValues),
      redactValue(item, protectedValues),
    ]),
  );
}
