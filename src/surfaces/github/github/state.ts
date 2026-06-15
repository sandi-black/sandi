import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const MAX_PROCESSED_TRIGGERS = 2_000;

const ProcessedTriggerSchema = z.object({
  key: z.string(),
  processedAt: z.string(),
  notificationId: z.string(),
  reason: z.string(),
  repository: z.string(),
  subject: z.string(),
});

const GitHubSurfaceStateSchema = z.object({
  version: z.literal(1),
  processedTriggers: z.record(z.string(), ProcessedTriggerSchema),
});

export type ProcessedTrigger = z.infer<typeof ProcessedTriggerSchema>;
export type GitHubSurfaceState = z.infer<typeof GitHubSurfaceStateSchema>;

export class GitHubNotificationState {
  readonly #store: JsonFileStore<GitHubSurfaceState>;

  constructor(dataDir: string) {
    this.#store = new JsonFileStore(
      join(dataDir, "github", "state.json"),
      GitHubSurfaceStateSchema,
    );
  }

  async hasProcessed(key: string): Promise<boolean> {
    const state = await this.#read();
    return state.processedTriggers[key] !== undefined;
  }

  async markProcessed(
    input: Omit<ProcessedTrigger, "processedAt">,
  ): Promise<void> {
    await this.#store.update((state) => {
      const processedTriggers = {
        ...state.processedTriggers,
        [input.key]: {
          ...input,
          processedAt: new Date().toISOString(),
        },
      };
      return {
        version: 1,
        processedTriggers: pruneProcessedTriggers(processedTriggers),
      };
    }, defaultState());
  }

  #read(): Promise<GitHubSurfaceState> {
    return this.#store.read(defaultState());
  }
}

function defaultState(): GitHubSurfaceState {
  return {
    version: 1,
    processedTriggers: {},
  };
}

function pruneProcessedTriggers(
  triggers: Record<string, ProcessedTrigger>,
): Record<string, ProcessedTrigger> {
  const entries = Object.entries(triggers).sort((left, right) =>
    left[1].processedAt.localeCompare(right[1].processedAt),
  );
  const keep = entries.slice(
    Math.max(0, entries.length - MAX_PROCESSED_TRIGGERS),
  );
  return Object.fromEntries(keep);
}
