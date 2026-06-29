import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";
import type {
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";
import { createLogger } from "@/lib/logging";
import { JsonFileStore } from "@/lib/state/file-store";

const log = createLogger("conversation-store");

const ParticipantSchema = z
  .object({
    platform: z.enum(["discord", "github"]),
    platformUserId: z.string(),
    username: z.string(),
    displayName: z.string().optional(),
    identityId: z.string().optional(),
    joinedAt: z.string(),
  })
  .transform(normalizeParticipant);

const MemoryScopeSchema = z
  .object({
    label: z.string(),
    refPrefix: z.string(),
    area: z.string().optional(),
  })
  .transform(normalizeMemoryScope);

const ConversationManifestSchema = z.object({
  canonicalId: z.custom<ConversationManifest["canonicalId"]>(),
  surface: z.string(),
  platform: z.enum(["discord", "github"]),
  kind: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  starterParticipantRef: z.string(),
  participants: z.array(ParticipantSchema),
  memoryScopes: z.array(MemoryScopeSchema),
  surfacePrompt: z.string().optional(),
  surfaceContext: z.record(z.string(), z.unknown()).optional(),
});

export class ConversationStore {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  async getOrCreate(input: {
    storageId: string;
    fallback: ConversationManifest;
  }): Promise<ConversationManifest> {
    const fallback = ConversationManifestSchema.parse(input.fallback);
    return this.#storeFor(input.storageId).read(fallback);
  }

  async get(storageId: string): Promise<ConversationManifest | undefined> {
    try {
      const raw = await readFile(
        join(this.#dataDir, "conversations", storageId, "manifest.json"),
        "utf8",
      );
      return ConversationManifestSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
  }

  /**
   * Reads every stored conversation manifest. Used by background work (such as
   * memory consolidation) that needs to sweep all conversations rather than look
   * one up by id. Unreadable or malformed manifests are skipped so one bad file
   * never breaks the sweep.
   */
  async list(): Promise<ConversationManifest[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(this.#dataDir, "conversations"), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    const manifests: ConversationManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await this.get(entry.name);
        if (manifest) manifests.push(manifest);
      } catch (error) {
        // Skip a manifest that fails to read or parse so one bad conversation
        // does not stop the rest from being consolidated, but log it so the
        // skipped conversation is visible rather than silently absent.
        log.warn("skipping unreadable conversation manifest", {
          storageId: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return manifests;
  }

  async addParticipant(input: {
    storageId: string;
    manifest: ConversationManifest;
    participant: ConversationParticipant;
  }): Promise<ConversationManifest> {
    const store = this.#storeFor(input.storageId);
    const now = new Date().toISOString();
    const updated = await store.updateManaged((current) => {
      const exists = current.participants.some(
        (item) => participantRef(item) === participantRef(input.participant),
      );
      if (exists) {
        return {
          ...current,
          updatedAt: now,
          participants: current.participants.map((item) =>
            participantRef(item) === participantRef(input.participant)
              ? mergeParticipant(item, input.participant)
              : item,
          ),
        };
      }
      return {
        ...current,
        updatedAt: now,
        participants: [...current.participants, input.participant],
      };
    }, input.manifest);
    return updated;
  }

  /**
   * Reads the current manifest, applies the mutator, and writes the result all
   * inside one cross-process lock. Use this instead of read-then-save so a
   * concurrent addParticipant in another process is not clobbered: the mutator
   * sees the freshest on-disk manifest, not one read earlier outside the lock.
   */
  async applyManaged(input: {
    storageId: string;
    fallback: ConversationManifest;
    mutate: (current: ConversationManifest) => ConversationManifest;
  }): Promise<ConversationManifest> {
    const fallback = ConversationManifestSchema.parse(input.fallback);
    return this.#storeFor(input.storageId).updateManaged(
      (current) => input.mutate(current),
      fallback,
    );
  }

  #storeFor(targetId: string): JsonFileStore<ConversationManifest> {
    return new JsonFileStore(
      join(this.#dataDir, "conversations", targetId, "manifest.json"),
      ConversationManifestSchema,
    );
  }
}

function normalizeMemoryScope(input: {
  label: string;
  refPrefix: string;
  area?: string | undefined;
}): ConversationMemoryScope {
  const scope: ConversationMemoryScope = {
    label: input.label,
    refPrefix: normalizeSurfaceMemoryScopeRefPrefix(input.refPrefix),
  };
  if (input.area !== undefined) scope.area = input.area;
  return scope;
}

function normalizeSurfaceMemoryScopeRefPrefix(refPrefix: string): string {
  const normalized = refPrefix.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid conversation memory scope ref prefix: ${refPrefix}`,
    );
  }
  const root = parts[0];
  if (
    root === "system" ||
    root === "self" ||
    root === "household" ||
    root === "topics" ||
    root === "discord" ||
    root === "github"
  ) {
    throw new Error(
      `Conversation memory scope overlaps a core memory root: ${refPrefix}`,
    );
  }
  return parts.join("/");
}

function mergeParticipant(
  current: ConversationParticipant,
  next: ConversationParticipant,
): ConversationParticipant {
  const merged: ConversationParticipant = {
    ...current,
    username: next.username,
  };
  if (next.displayName !== undefined) merged.displayName = next.displayName;
  if (next.identityId !== undefined) merged.identityId = next.identityId;
  return merged;
}

function normalizeParticipant(input: {
  platform: ConversationParticipant["platform"];
  platformUserId: string;
  username: string;
  displayName?: string | undefined;
  identityId?: string | undefined;
  joinedAt: string;
}): ConversationParticipant {
  const participant: ConversationParticipant = {
    platform: input.platform,
    platformUserId: input.platformUserId,
    username: input.username,
    joinedAt: input.joinedAt,
  };
  if (input.displayName !== undefined) {
    participant.displayName = input.displayName;
  }
  if (input.identityId !== undefined) {
    participant.identityId = input.identityId;
  }
  return participant;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
