// Narrows an unknown value to a plain object shape, distinct from arrays,
// so callers can safely index into parsed JSON or deserialized state before
// validating individual fields.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
