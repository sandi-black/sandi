import { type FSWatcher, watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Cron } from "croner";

import type { ConversationStore } from "@/lib/conversations/store";
import type { Logger } from "@/lib/logging";
import {
  conversationHasUnencodedActivity,
  encodeConversation,
  freshNotesForConversation,
  runDreamForConversation,
} from "@/lib/memory/consolidation";
import { DreamStateStore } from "@/lib/memory/dream-state";
import type { DreamingConfig } from "@/lib/memory/dreaming-config";
import type { ModelProviderClient } from "@/lib/provider/pi-cli-client";

export type MemoryDreaming = {
  stop(): void;
};

export type MemoryDreamingInput = {
  dataDir: string;
  sessionDir: string;
  provider: ModelProviderClient;
  conversations: ConversationStore;
  config: DreamingConfig;
  logger: Logger;
};

/**
 * Starts automatic memory consolidation. Two rhythms run in the background, both
 * reusing the normal provider turn machinery:
 *  - short-term encoding: a debounced timer fires ~idleMs after a conversation
 *    goes quiet (detected by watching its manifest), summarizing it into an
 *    episodic note.
 *  - the overnight dream: a nightly cron consolidates the notes written since
 *    the last dream into durable memory, one conversation at a time.
 * Returns a handle whose stop() tears every watcher and timer down for graceful
 * shutdown. A disabled config is a no-op.
 */
export function startMemoryDreaming(
  input: MemoryDreamingInput,
): MemoryDreaming {
  if (!input.config.enabled) {
    input.logger.info("memory dreaming disabled");
    return {
      stop() {
        /* nothing was scheduled */
      },
    };
  }
  const service = new DreamingService(input);
  service.start();
  return { stop: () => service.stop() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DreamingService {
  readonly #input: MemoryDreamingInput;
  readonly #conversationsDir: string;
  readonly #memoryRoot: string;
  readonly #dreamState: DreamStateStore;
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #conversationWatchers: FSWatcher[] = [];
  readonly #encoding = new Set<string>();
  readonly #pendingEncode = new Set<string>();
  readonly #knownConversations = new Set<string>();
  readonly #abort = new AbortController();
  #rootWatcher: FSWatcher | undefined;
  #cron: Cron | undefined;
  #stopped = false;
  #dreaming = false;

  constructor(input: MemoryDreamingInput) {
    this.#input = input;
    this.#conversationsDir = join(input.dataDir, "conversations");
    this.#memoryRoot = join(input.dataDir, "memory");
    this.#dreamState = new DreamStateStore(input.dataDir);
  }

  start(): void {
    this.#fireAndLog(this.#initWatchers(), "dreaming watcher init failed");
    this.#cron = new Cron(
      this.#input.config.nightlyCron,
      { timezone: this.#input.config.timezone },
      () => {
        void this.#runDreamSweep();
      },
    );
    this.#input.logger.info("memory dreaming started", {
      idleMs: this.#input.config.idleMs,
      nightlyCron: this.#input.config.nightlyCron,
      timezone: this.#input.config.timezone,
    });
  }

  stop(): void {
    this.#stopped = true;
    // Abort any encode or dream currently inside a provider turn so shutdown does
    // not block on the pi child until the provider timeout.
    this.#abort.abort();
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    this.#pendingEncode.clear();
    this.#rootWatcher?.close();
    this.#rootWatcher = undefined;
    this.#closeConversationWatchers();
    this.#cron?.stop();
    this.#cron = undefined;
  }

  // Runs background work that is intentionally not awaited (watcher setup fired
  // from a constructor or fs.watch callback) while still surfacing a rejection,
  // so a failure is logged rather than becoming an unhandled promise rejection.
  #fireAndLog(work: Promise<void>, message: string): void {
    void work.catch((error: unknown) => {
      this.#input.logger.error(message, { error: errorMessage(error) });
    });
  }

  // Watches the conversations directory for new conversations (root watcher) and
  // each conversation's manifest for turn activity. fs.watch is not reliably
  // recursive on Linux, so each subdirectory is watched directly, the same way
  // the embedding index maintainer does it.
  async #initWatchers(): Promise<void> {
    if (this.#stopped) return;
    await mkdir(this.#conversationsDir, { recursive: true });
    if (!this.#rootWatcher) {
      try {
        this.#rootWatcher = watch(
          this.#conversationsDir,
          { persistent: true },
          () => {
            this.#fireAndLog(
              this.#refreshConversationWatchers(),
              "dreaming watcher refresh failed",
            );
          },
        );
      } catch (error) {
        this.#input.logger.warn("dreaming root watch failed", {
          error: errorMessage(error),
        });
      }
    }
    await this.#refreshConversationWatchers();
  }

  async #refreshConversationWatchers(): Promise<void> {
    if (this.#stopped) return;
    this.#closeConversationWatchers();
    let storageIds: string[];
    try {
      const entries = await readdir(this.#conversationsDir, {
        withFileTypes: true,
      });
      storageIds = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      // A failure listing the conversations directory leaves idle encoding
      // disabled, so surface it rather than silently treating it as "no
      // conversations to watch".
      this.#input.logger.error("dreaming watcher refresh could not list", {
        error: errorMessage(error),
      });
      return;
    }
    for (const storageId of storageIds) {
      try {
        const watcher = watch(
          join(this.#conversationsDir, storageId),
          { persistent: true },
          (_event, filename) => {
            if (
              typeof filename === "string" &&
              !filename.startsWith("manifest")
            ) {
              return;
            }
            this.#scheduleIdleEncode(storageId);
          },
        );
        this.#conversationWatchers.push(watcher);
      } catch (error) {
        this.#input.logger.warn("dreaming conversation watch failed", {
          storageId,
          error: errorMessage(error),
        });
      }
    }
    await this.#armEncodesForDiscoveredConversations(storageIds);
  }

  // Arms an idle encode for each newly-seen conversation that has activity no
  // recap has captured yet. This covers two cases a filesystem event alone would
  // miss: a conversation directory created after startup (the root watcher
  // discovers it only after the creating manifest write already fired its own
  // not-yet-existing directory watcher), and a conversation that went quiet
  // during a host restart (after its last turn but before its idle timer fired).
  // On the first run with dreaming enabled, nothing has a recap yet, so every
  // conversation is armed; this batch is expected.
  async #armEncodesForDiscoveredConversations(
    storageIds: string[],
  ): Promise<void> {
    for (const storageId of storageIds) {
      if (this.#stopped) return;
      if (this.#knownConversations.has(storageId)) continue;
      this.#knownConversations.add(storageId);
      try {
        const manifest = await this.#input.conversations.get(storageId);
        if (!manifest) continue;
        const pending = await conversationHasUnencodedActivity({
          memoryRoot: this.#memoryRoot,
          manifest,
        });
        if (pending) this.#scheduleIdleEncode(storageId);
      } catch (error) {
        this.#input.logger.warn("dreaming startup encode check failed", {
          storageId,
          error: errorMessage(error),
        });
      }
    }
    for (const known of [...this.#knownConversations]) {
      if (!storageIds.includes(known)) this.#knownConversations.delete(known);
    }
  }

  #closeConversationWatchers(): void {
    for (const watcher of this.#conversationWatchers) watcher.close();
    this.#conversationWatchers.length = 0;
  }

  #scheduleIdleEncode(storageId: string): void {
    if (this.#stopped) return;
    const existing = this.#idleTimers.get(storageId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(storageId);
      void this.#encodeConversation(storageId);
    }, this.#input.config.idleMs);
    this.#idleTimers.set(storageId, timer);
  }

  async #encodeConversation(storageId: string): Promise<void> {
    if (this.#stopped) return;
    if (this.#encoding.has(storageId)) {
      // An encode is already running for this conversation. Remember to run
      // again once it finishes so activity that arrived mid-encode (after the
      // running pass read the transcript) is still captured.
      this.#pendingEncode.add(storageId);
      return;
    }
    this.#encoding.add(storageId);
    try {
      const manifest = await this.#input.conversations.get(storageId);
      if (!manifest) return;
      await encodeConversation({
        provider: this.#input.provider,
        dataDir: this.#input.dataDir,
        sessionDir: this.#input.sessionDir,
        manifest,
        now: new Date(),
        transcriptCharBudget: this.#input.config.transcriptCharBudget,
        logger: this.#input.logger,
        signal: this.#abort.signal,
      });
    } catch (error) {
      this.#input.logger.error("conversation encode failed", {
        storageId,
        error: errorMessage(error),
      });
    } finally {
      this.#encoding.delete(storageId);
      if (this.#pendingEncode.delete(storageId) && !this.#stopped) {
        this.#scheduleIdleEncode(storageId);
      }
    }
  }

  async #runDreamSweep(): Promise<void> {
    if (this.#stopped || this.#dreaming) return;
    this.#dreaming = true;
    const startedAt = new Date();
    try {
      const manifests = await this.#input.conversations.list();
      let dreamed = 0;
      let failed = 0;
      for (const manifest of manifests) {
        if (this.#stopped) break;
        try {
          // The dream watermark is per conversation: a conversation is only
          // advanced past its fresh notes once its dream succeeds, so a failed
          // or skipped consolidation retries on the next sweep instead of being
          // silently lost.
          const since = await this.#dreamState.lastDreamAt(
            manifest.canonicalId,
          );
          const notes = await freshNotesForConversation({
            memoryRoot: this.#memoryRoot,
            manifest,
            since,
          });
          if (notes.length === 0) continue;
          const result = await runDreamForConversation({
            provider: this.#input.provider,
            dataDir: this.#input.dataDir,
            sessionDir: this.#input.sessionDir,
            manifest,
            notes,
            transcriptCharBudget: this.#input.config.transcriptCharBudget,
            logger: this.#input.logger,
            signal: this.#abort.signal,
          });
          if (result.dreamed) {
            dreamed += 1;
            await this.#dreamState.markDreamed(manifest.canonicalId, startedAt);
          }
        } catch (error) {
          failed += 1;
          this.#input.logger.error("dream failed for conversation", {
            conversationId: manifest.canonicalId,
            error: errorMessage(error),
          });
        }
      }
      this.#input.logger.info("dream sweep complete", {
        conversations: manifests.length,
        dreamed,
        failed,
      });
    } catch (error) {
      this.#input.logger.error("dream sweep failed", {
        error: errorMessage(error),
      });
    } finally {
      this.#dreaming = false;
    }
  }
}
