import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const MAX_PROCESSED_TRIGGERS = 2_000;
// A processing claim is abandoned if it is not cleared within this window: the
// claiming process crashed or was killed mid-turn. Once stale, another process
// may reclaim the trigger. Kept generous so a slow but live turn is never
// stolen, since a duplicate GitHub reply is worse than a delayed retry.
const CLAIM_STALE_MS = 30 * 60_000;

const ProcessedTriggerSchema = z.object({
  key: z.string(),
  processedAt: z.string(),
  notificationId: z.string(),
  reason: z.string(),
  repository: z.string(),
  subject: z.string(),
});

const ProcessingClaimSchema = z.object({
  key: z.string(),
  claimedAt: z.string(),
  pid: z.number(),
});

const GitHubSurfaceStateSchema = z.object({
  version: z.literal(1),
  processedTriggers: z.record(z.string(), ProcessedTriggerSchema),
  processingClaims: z.record(z.string(), ProcessingClaimSchema).default({}),
});

export type ProcessedTrigger = z.infer<typeof ProcessedTriggerSchema>;
export type GitHubSurfaceState = z.infer<typeof GitHubSurfaceStateSchema>;

export type ClaimTriggerResult =
  | "claimed"
  | "already-processed"
  | "claimed-elsewhere";

export class GitHubNotificationState {
  readonly #store: JsonFileStore<GitHubSurfaceState>;

  constructor(dataDir: string) {
    this.#store = new JsonFileStore(
      join(dataDir, "github", "state.json"),
      GitHubSurfaceStateSchema,
    );
  }

  async hasProcessed(key: string): Promise<boolean> {
    const state = await this.#store.read(defaultState());
    return state.processedTriggers[key] !== undefined;
  }

  /**
   * Atomically claims a trigger for processing. Inside one cross-process lock it
   * checks whether the trigger is already processed or actively claimed by a
   * live process, and if not records a fresh claim. Two processes can therefore
   * never both run the same trigger: exactly one gets "claimed". A claim left
   * behind by a crashed process is reclaimable once it ages past CLAIM_STALE_MS.
   */
  async tryClaim(key: string): Promise<ClaimTriggerResult> {
    let result: ClaimTriggerResult = "claimed";
    await this.#store.updateManaged((state) => {
      if (state.processedTriggers[key] !== undefined) {
        result = "already-processed";
        return state;
      }
      const existing = state.processingClaims[key];
      if (existing && !isStaleClaim(existing)) {
        result = "claimed-elsewhere";
        return state;
      }
      result = "claimed";
      return {
        ...state,
        processingClaims: {
          ...state.processingClaims,
          [key]: {
            key,
            claimedAt: new Date().toISOString(),
            pid: process.pid,
          },
        },
      };
    }, defaultState());
    return result;
  }

  /** Releases a claim without marking the trigger processed (e.g. on failure). */
  async releaseClaim(key: string): Promise<void> {
    await this.#store.updateManaged((state) => {
      if (state.processingClaims[key] === undefined) return state;
      const processingClaims = { ...state.processingClaims };
      delete processingClaims[key];
      return { ...state, processingClaims };
    }, defaultState());
  }

  async markProcessed(
    input: Omit<ProcessedTrigger, "processedAt">,
  ): Promise<void> {
    await this.#store.updateManaged((state) => {
      const processedTriggers = {
        ...state.processedTriggers,
        [input.key]: {
          ...input,
          processedAt: new Date().toISOString(),
        },
      };
      const processingClaims = { ...state.processingClaims };
      delete processingClaims[input.key];
      return {
        version: 1,
        processedTriggers: pruneProcessedTriggers(processedTriggers),
        processingClaims,
      };
    }, defaultState());
  }
}

function isStaleClaim(claim: z.infer<typeof ProcessingClaimSchema>): boolean {
  const claimedAt = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedAt)) return true;
  return Date.now() - claimedAt > CLAIM_STALE_MS;
}

function defaultState(): GitHubSurfaceState {
  return {
    version: 1,
    processedTriggers: {},
    processingClaims: {},
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
