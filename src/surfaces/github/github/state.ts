import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const MAX_PROCESSED_TRIGGERS = 2_000;
// A processing claim is abandoned if it is not cleared within this window: the
// claiming process crashed or was killed mid-turn. Once stale, another process
// may reclaim the trigger. Kept generous so a slow but live turn is never
// stolen, since a duplicate GitHub reply is worse than a delayed retry.
export const CLAIM_STALE_MS = 30 * 60_000;
export const CLAIM_RENEWAL_MS = 5 * 60_000;

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
  // Legacy claims predate ownership ids. They are treated as stale so a new
  // worker can replace them safely during the first post-upgrade poll.
  claimId: z.string().uuid().optional(),
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

export type TriggerClaim = { key: string; claimId: string };

export type ClaimTriggerResult =
  | { status: "claimed"; claim: TriggerClaim }
  | "already-processed"
  | "claimed-elsewhere";

export class GitHubNotificationState {
  readonly #store: JsonFileStore<GitHubSurfaceState>;
  readonly #now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.#store = new JsonFileStore(
      join(dataDir, "github", "state.json"),
      GitHubSurfaceStateSchema,
    );
    this.#now = now;
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
    const claim: TriggerClaim = { key, claimId: randomUUID() };
    let result: ClaimTriggerResult = { status: "claimed", claim };
    await this.#store.updateManaged((state) => {
      const processingClaims = removeStaleClaims(
        state.processingClaims,
        this.#now(),
      );
      if (state.processedTriggers[key] !== undefined) {
        result = "already-processed";
        return processingClaims === state.processingClaims
          ? state
          : { ...state, processingClaims };
      }
      if (processingClaims[key]) {
        result = "claimed-elsewhere";
        return processingClaims === state.processingClaims
          ? state
          : { ...state, processingClaims };
      }
      result = { status: "claimed", claim };
      return {
        ...state,
        processingClaims: {
          ...processingClaims,
          [key]: {
            key,
            claimId: claim.claimId,
            claimedAt: new Date(this.#now()).toISOString(),
            pid: process.pid,
          },
        },
      };
    }, defaultState());
    return result;
  }

  async renewClaim(claim: TriggerClaim): Promise<boolean> {
    let renewed = false;
    await this.#store.updateManaged((state) => {
      const existing = state.processingClaims[claim.key];
      if (existing?.claimId !== claim.claimId) return state;
      renewed = true;
      return {
        ...state,
        processingClaims: {
          ...state.processingClaims,
          [claim.key]: {
            ...existing,
            claimedAt: new Date(this.#now()).toISOString(),
          },
        },
      };
    }, defaultState());
    return renewed;
  }

  /** Releases only the caller's claim, never a newer worker's replacement. */
  async releaseClaim(claim: TriggerClaim): Promise<boolean> {
    let released = false;
    await this.#store.updateManaged((state) => {
      if (state.processingClaims[claim.key]?.claimId !== claim.claimId) {
        return state;
      }
      const processingClaims = { ...state.processingClaims };
      delete processingClaims[claim.key];
      released = true;
      return { ...state, processingClaims };
    }, defaultState());
    return released;
  }

  async markProcessed(
    input: Omit<ProcessedTrigger, "processedAt">,
    claim?: TriggerClaim,
  ): Promise<boolean> {
    let marked = false;
    await this.#store.updateManaged((state) => {
      const existing = state.processingClaims[input.key];
      if (
        (claim && existing?.claimId !== claim.claimId) ||
        (!claim && existing !== undefined)
      ) {
        return state;
      }
      const processedTriggers = {
        ...state.processedTriggers,
        [input.key]: {
          ...input,
          processedAt: new Date().toISOString(),
        },
      };
      const processingClaims = { ...state.processingClaims };
      delete processingClaims[input.key];
      marked = true;
      return {
        version: 1,
        processedTriggers: pruneProcessedTriggers(processedTriggers),
        processingClaims,
      };
    }, defaultState());
    return marked;
  }
}

function isStaleClaim(
  claim: z.infer<typeof ProcessingClaimSchema>,
  now: number,
): boolean {
  if (!claim.claimId) return true;
  const claimedAt = Date.parse(claim.claimedAt);
  if (!Number.isFinite(claimedAt)) return true;
  return now - claimedAt > CLAIM_STALE_MS;
}

function removeStaleClaims(
  claims: GitHubSurfaceState["processingClaims"],
  now: number,
): GitHubSurfaceState["processingClaims"] {
  const entries = Object.entries(claims).filter(
    ([, claim]) => !isStaleClaim(claim, now),
  );
  if (entries.length === Object.keys(claims).length) return claims;
  return Object.fromEntries(entries);
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
