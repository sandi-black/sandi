import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "@/lib/logging";
import {
  memoryEmbeddingIndexSnapshot,
  rebuildMemoryEmbeddingIndex,
} from "@/lib/pi-extension/memory-hybrid-search";
import {
  rebuildSkillEmbeddingIndex,
  skillEmbeddingIndexSnapshot,
} from "@/lib/pi-extension/skill-hybrid-search";
import {
  EMBEDDING_INDEX_VERSION,
  type EmbeddingIndexKind,
  embeddingIndexCacheRoot,
  readCurrentEmbeddingIndexManifest,
} from "@/lib/retrieval/embedding-index";
import {
  createEmbeddingEngineFromEnv,
  type EmbeddingEngine,
} from "@/lib/retrieval/embeddings";

export type EmbeddingIndexMaintenance = {
  stop(): void;
};

type IndexMaintainerInput = {
  kind: EmbeddingIndexKind;
  sourceRoot: string;
  cacheRoot: string;
  debounceMs: number;
  logger: Logger;
  snapshot(root: string): Promise<{ contentHash: string; files: unknown[] }>;
  rebuild(input: {
    root: string;
    cacheRoot: string;
    embeddingEngine: EmbeddingEngine;
  }): Promise<{ rebuilt: boolean }>;
};

type MaintainerState = {
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  rebuilding: boolean;
  queued: boolean;
  stopped: boolean;
};

const DEFAULT_DEBOUNCE_MS = 2_000;

export function startEmbeddingIndexMaintenance(input: {
  dataDir: string;
  skillsRoot: string;
  memoryRoot: string;
  logger: Logger;
  debounceMs?: number | undefined;
}): EmbeddingIndexMaintenance {
  const cacheRoot = embeddingIndexCacheRoot(input.dataDir);
  const debounceMs = input.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maintainers = [
    startIndexMaintainer({
      kind: "skills",
      sourceRoot: input.skillsRoot,
      cacheRoot,
      debounceMs,
      logger: input.logger,
      snapshot: skillEmbeddingIndexSnapshot,
      rebuild: async ({ root, cacheRoot: indexCacheRoot, embeddingEngine }) =>
        await rebuildSkillEmbeddingIndex({
          root,
          cacheRoot: indexCacheRoot,
          embeddingEngine,
        }),
    }),
    startIndexMaintainer({
      kind: "memory",
      sourceRoot: input.memoryRoot,
      cacheRoot,
      debounceMs,
      logger: input.logger,
      snapshot: memoryEmbeddingIndexSnapshot,
      rebuild: async ({ root, cacheRoot: indexCacheRoot, embeddingEngine }) =>
        await rebuildMemoryEmbeddingIndex({
          root,
          cacheRoot: indexCacheRoot,
          embeddingEngine,
        }),
    }),
  ];
  return {
    stop() {
      for (const maintainer of maintainers) maintainer.stop();
    },
  };
}

function startIndexMaintainer(
  input: IndexMaintainerInput,
): EmbeddingIndexMaintenance {
  const state: MaintainerState = {
    watchers: [],
    timer: null,
    rebuilding: false,
    queued: false,
    stopped: false,
  };

  void refreshWatchers(input, state);
  void ensureFresh(input, state, "startup");

  return {
    stop() {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      closeWatchers(state);
    },
  };
}

async function ensureFresh(
  input: IndexMaintainerInput,
  state: MaintainerState,
  reason: string,
): Promise<void> {
  if (state.stopped) return;
  if (state.rebuilding) {
    state.queued = true;
    return;
  }

  state.rebuilding = true;
  try {
    const engine = createEmbeddingEngineFromEnv();
    if (!engine) {
      input.logger.warn("embedding index maintenance skipped", {
        kind: input.kind,
        reason: "embedding provider disabled",
      });
      return;
    }

    const snapshot = await input.snapshot(input.sourceRoot);
    const current = await readCurrentEmbeddingIndexManifest({
      kind: input.kind,
      cacheRoot: input.cacheRoot,
    });
    if (
      current &&
      current.version === EMBEDDING_INDEX_VERSION &&
      current.contentHash === snapshot.contentHash &&
      current.embeddingEngine === engine.name
    ) {
      input.logger.info("embedding index current", {
        kind: input.kind,
        reason,
        generation: current.generation,
        sourceFileCount: snapshot.files.length,
      });
      return;
    }

    input.logger.info("embedding index rebuild started", {
      kind: input.kind,
      reason,
      sourceFileCount: snapshot.files.length,
    });
    const result = await input.rebuild({
      root: input.sourceRoot,
      cacheRoot: input.cacheRoot,
      embeddingEngine: engine,
    });
    if (result.rebuilt) {
      input.logger.info("embedding index rebuild completed", {
        kind: input.kind,
      });
    } else {
      input.logger.warn("embedding index rebuild skipped", {
        kind: input.kind,
      });
    }
  } catch (error) {
    input.logger.error("embedding index maintenance failed", {
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    state.rebuilding = false;
    await refreshWatchers(input, state);
    if (state.queued && !state.stopped) {
      state.queued = false;
      scheduleEnsureFresh(input, state, "queued change");
    }
  }
}

async function refreshWatchers(
  input: IndexMaintainerInput,
  state: MaintainerState,
): Promise<void> {
  if (state.stopped) return;
  closeWatchers(state);
  const dirs = await listDirectories(input.sourceRoot);
  for (const dir of dirs) {
    try {
      state.watchers.push(
        watch(dir, { persistent: true }, () => {
          scheduleEnsureFresh(input, state, "filesystem change");
        }),
      );
    } catch (error) {
      input.logger.warn("embedding index watch failed", {
        kind: input.kind,
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function scheduleEnsureFresh(
  input: IndexMaintainerInput,
  state: MaintainerState,
  reason: string,
): void {
  if (state.stopped) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void ensureFresh(input, state, reason);
  }, input.debounceMs);
}

function closeWatchers(state: MaintainerState): void {
  for (const watcher of state.watchers) watcher.close();
  state.watchers = [];
}

async function listDirectories(root: string): Promise<string[]> {
  const dirs: string[] = [];
  await collectDirectories(root, dirs);
  return dirs;
}

async function collectDirectories(dir: string, dirs: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirs.push(dir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await collectDirectories(join(dir, entry.name), dirs);
  }
}
