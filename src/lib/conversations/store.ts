import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";
import type {
  ConversationManifest,
  ConversationMemoryScope,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { participantRef } from "@/lib/conversations/types";
import { errorMessage } from "@/lib/errors";
import { isMissingFileError } from "@/lib/fs-errors";
import { createLogger } from "@/lib/logging";
import { normalizeRefPrefix } from "@/lib/memory-refs";
import { JsonFileStore } from "@/lib/state/file-store";

const log = createLogger("conversation-store");

// Storage ids are directory names under data/conversations. Every production
// surface already emits this alphabet; parsing it here keeps a hand-edited
// manifest call or a future surface from escaping that root.
const ConversationStorageIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,799}$/);

// Platform ids become user-memory and user-config directory names. Discord and
// GitHub immutable ids, plus their documented username fallbacks, fit this
// lossless path-segment alphabet.
const PlatformUserIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

const ParticipantSchema = z
  .object({
    platform: z.enum(["discord", "github"]),
    platformUserId: PlatformUserIdSchema,
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
  canonicalId: z.string().min(1),
  surface: z.string(),
  platform: z.enum(["discord", "github"]),
  kind: z.string(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  starterParticipantRef: z.string(),
  participants: z.array(ParticipantSchema),
  memoryScopes: z.array(MemoryScopeSchema),
  attachmentHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
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
    const parsedStorageId = ConversationStorageIdSchema.parse(storageId);
    try {
      const raw = await readFile(
        join(this.#dataDir, "conversations", parsedStorageId, "manifest.json"),
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
        if (manifest) {
          manifests.push(manifest);
        } else {
          // A conversation directory with no manifest.json is a corrupt state,
          // not an absent conversation; surface it rather than skip silently.
          log.warn("conversation directory has no manifest", {
            storageId: entry.name,
          });
        }
      } catch (error) {
        // Skip a manifest that fails to read or parse so one bad conversation
        // does not stop the rest from being consolidated, but log it so the
        // skipped conversation is visible rather than silently absent.
        log.warn("skipping unreadable conversation manifest", {
          storageId: entry.name,
          error: errorMessage(error),
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

  async addAttachmentReferences(input: {
    storageId: string;
    manifest: ConversationManifest;
    hashes: readonly string[];
  }): Promise<ConversationManifest> {
    if (input.hashes.length === 0) return input.manifest;
    const hashes = new Set(input.hashes);
    return this.#storeFor(input.storageId).updateManaged(
      (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        attachmentHashes: [
          ...new Set([...(current.attachmentHashes ?? []), ...hashes]),
        ],
      }),
      input.manifest,
    );
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
    const storageId = ConversationStorageIdSchema.parse(targetId);
    return new JsonFileStore(
      join(this.#dataDir, "conversations", storageId, "manifest.json"),
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
    refPrefix: normalizeRefPrefix(input.refPrefix, {
      invalidLabel: "conversation memory scope ref prefix",
    }),
  };
  if (input.area !== undefined) scope.area = input.area;
  return scope;
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
