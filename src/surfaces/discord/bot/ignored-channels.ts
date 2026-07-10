import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "@/lib/errors";
import { isMissingFileError } from "@/lib/fs-errors";
import { createLogger } from "@/lib/logging";
import {
  atomicWriteInPlace,
  withManagedWrite,
} from "@/lib/state/managed-write";

const log = createLogger("bot");

export const IGNORED_CHANNELS_PATH = "discord/ignored-channels.json";

type ChannelIdConfig = {
  channels: Array<{ id: string }>;
};

/**
 * Loads the set of Discord channel/thread IDs Sandi should ignore. Ignored
 * targets are skipped entirely unless Sandi is explicitly @-mentioned. A
 * missing or invalid file means nothing is ignored.
 */
export async function loadIgnoredConversationChannels(
  dataDir: string,
): Promise<Set<string>> {
  const filePath = join(dataDir, IGNORED_CHANNELS_PATH);
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isChannelIdConfig(parsed)) {
      log.warn("ignoring invalid ignored channels config", { filePath });
      return new Set();
    }
    return new Set(parsed.channels.map((channel) => channel.id));
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Set();
    }
    log.warn("failed to load ignored channels config", {
      filePath,
      error: errorMessage(error),
    });
    return new Set();
  }
}

/**
 * Adds a channel/thread ID to the ignore list and persists it, returning the
 * updated set. Idempotent: re-adding an existing ID rewrites the same file.
 */
export async function appendIgnoredConversationChannel(
  dataDir: string,
  channelId: string,
): Promise<Set<string>> {
  const filePath = join(dataDir, IGNORED_CHANNELS_PATH);
  return withManagedWrite(filePath, async () => {
    const channels = await loadIgnoredConversationChannels(dataDir);
    channels.add(channelId);
    const payload: ChannelIdConfig = {
      channels: [...channels].map((id) => ({ id })),
    };
    await atomicWriteInPlace(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return channels;
  });
}

/**
 * Removes a channel/thread ID from the ignore list and persists the result.
 * Returns the updated set and whether the ID was present. The file is only
 * rewritten when something actually changed.
 */
export async function removeIgnoredConversationChannel(
  dataDir: string,
  channelId: string,
): Promise<{ channels: Set<string>; removed: boolean }> {
  const filePath = join(dataDir, IGNORED_CHANNELS_PATH);
  return withManagedWrite(filePath, async () => {
    const channels = await loadIgnoredConversationChannels(dataDir);
    const removed = channels.delete(channelId);
    if (removed) {
      const payload: ChannelIdConfig = {
        channels: [...channels].map((id) => ({ id })),
      };
      await atomicWriteInPlace(
        filePath,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    }
    return { channels, removed };
  });
}

function isChannelIdConfig(value: unknown): value is ChannelIdConfig {
  const channels = objectProperty(value, "channels");
  if (!Array.isArray(channels)) return false;
  return channels.every((channel) => {
    const id = objectProperty(channel, "id");
    return typeof id === "string" && /^\d+$/.test(id);
  });
}

function objectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (!(key in value)) return undefined;
  return Reflect.get(value, key);
}
