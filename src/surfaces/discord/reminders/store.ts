import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  chmodPrivateFile,
  writePrivateTextFile,
} from "@/lib/state/private-files";
import {
  type Reminder,
  ReminderSchema,
} from "@/surfaces/discord/reminders/schemas";

const REMINDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export type StoredReminder = {
  id: string;
  reminder: Reminder;
};

export async function listReminders(root: string): Promise<StoredReminder[]> {
  const absoluteRoot = resolve(root);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const reminders: StoredReminder[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    try {
      reminders.push({ id, reminder: await readReminder(absoluteRoot, id) });
    } catch {}
  }
  return reminders.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readReminder(
  root: string,
  id: string,
): Promise<Reminder> {
  const content = await readFile(resolveReminderPath(root, id), "utf8");
  return ReminderSchema.parse(JSON.parse(content));
}

export async function writeReminder(
  root: string,
  id: string,
  reminder: Reminder,
): Promise<void> {
  const parsed = ReminderSchema.parse(reminder);
  const filePath = resolveReminderPath(root, id);
  await mkdir(resolve(root), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writePrivateTextFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await rename(tempPath, filePath);
  await chmodPrivateFile(filePath);
}

export async function deleteReminder(root: string, id: string): Promise<void> {
  await rm(resolveReminderPath(root, id), { force: true });
}

export function resolveReminderPath(root: string, id: string): string {
  const absoluteRoot = resolve(root);
  const normalized = normalizeReminderId(id);
  const absolute = resolve(absoluteRoot, `${normalized}.json`);
  const relativePath = relative(absoluteRoot, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid reminder id: ${id}`);
  }
  return absolute;
}

export function normalizeReminderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!REMINDER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Reminder ids must be lowercase letters, numbers, dashes, or underscores.",
    );
  }
  return normalized;
}

export function defaultRemindersRoot(dataDir: string): string {
  return join(dataDir, "reminders");
}
