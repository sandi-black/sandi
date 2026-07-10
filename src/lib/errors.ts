// Error values caught from unknown sources (fetch failures, subprocess
// exits, third-party libraries) are not guaranteed to be Error instances.
// This normalizes any caught value into a displayable message without
// throwing on the values that aren't.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
