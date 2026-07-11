import { readdir, readFile, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { errorMessage } from "../../../lib/errors";
import { isMissingPathError } from "../../../lib/fs-errors";
import { createLogger } from "../../../lib/logging";
import {
  atomicWriteManaged,
  withManagedWrite,
} from "../../../lib/state/managed-write";
import { type SandiEvent, SandiEventSchema } from "./schemas";

const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const log = createLogger("event-store");

export type StoredEvent = {
  id: string;
  event: SandiEvent;
};

export async function listEvents(root: string): Promise<StoredEvent[]> {
  const absoluteRoot = resolve(root);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const events: StoredEvent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    try {
      events.push({ id, event: await readEvent(absoluteRoot, id) });
    } catch (error) {
      log.warn("skipping unreadable event", {
        id,
        error: errorMessage(error),
      });
    }
  }
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readEvent(root: string, id: string): Promise<SandiEvent> {
  const content = await readFile(resolveEventPath(root, id), "utf8");
  return SandiEventSchema.parse(JSON.parse(content));
}

export async function writeEvent(
  root: string,
  id: string,
  event: SandiEvent,
): Promise<void> {
  const parsed = SandiEventSchema.parse(event);
  const filePath = resolveEventPath(root, id);
  await atomicWriteManaged(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function deleteEvent(root: string, id: string): Promise<void> {
  const filePath = resolveEventPath(root, id);
  await withManagedWrite(filePath, async () => {
    await rm(filePath, { force: true });
  });
}

export function resolveEventPath(root: string, id: string): string {
  const absoluteRoot = resolve(root);
  const normalized = normalizeEventId(id);
  const absolute = resolve(absoluteRoot, `${normalized}.json`);
  const relativePath = relative(absoluteRoot, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error(`Invalid event id: ${id}`);
  }
  return absolute;
}

export function normalizeEventId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!EVENT_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Event ids must be lowercase letters, numbers, dashes, or underscores.",
    );
  }
  return normalized;
}
