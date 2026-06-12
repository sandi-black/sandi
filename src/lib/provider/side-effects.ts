import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DELIVERY_SIDE_EFFECT_FILE_ENV = "SANDI_DELIVERY_SIDE_EFFECT_FILE";

export type DeliverySideEffectKind = string;

// Pi turns run out-of-process, so the bot wrapper cannot inspect in-memory
// state to know whether a tool already delivered a platform-visible response.
// Instead, the provider gives each turn a marker file path through the
// environment. Explicit delivery helpers append to that file, and the wrapper
// posts final assistant text only when the file stayed empty.
export async function recordDeliverySideEffect(
  kind: DeliverySideEffectKind,
): Promise<void> {
  const path = process.env[DELIVERY_SIDE_EFFECT_FILE_ENV]?.trim();
  if (!path) return;

  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({ kind, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export async function deliverySideEffectFileHasEntries(
  path: string,
): Promise<boolean> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().length > 0;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return hasCode(error) && error.code === "ENOENT";
}

function hasCode(error: unknown): error is { code: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}
