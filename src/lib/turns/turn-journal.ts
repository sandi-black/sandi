import { join } from "node:path";

import { z } from "zod/v4";
import { createLogger } from "@/lib/logging";
import { JsonFileStore } from "@/lib/state/file-store";

const log = createLogger("turn-journal");
const JsonValueSchema = z.json();
const IsoDateTimeSchema = z.iso.datetime();

const JournalEntrySchema = z.object({
  key: z.string().min(1),
  payload: JsonValueSchema,
  acceptedAt: IsoDateTimeSchema,
  attempts: z.number().int().nonnegative(),
});

const JournalStateSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), JournalEntrySchema),
});

export type TurnJournalEntry = z.infer<typeof JournalEntrySchema>;

export type TurnJournalOptions = {
  now?: () => number;
  /**
   * A turn older than this is dropped rather than replayed. Coming back from a
   * long outage and answering everything that queued up during it reads as a
   * flood, so the window covers a deploy restart and a fast crash and nothing
   * more.
   */
  maxAgeMs?: number;
  /**
   * A turn that kills the process takes the whole surface down with it every
   * time it is replayed, so give up on it after a few tries rather than boot
   * loop on one poisonous message.
   */
  maxAttempts?: number;
};

const DEFAULT_STATE: z.infer<typeof JournalStateSchema> = {
  version: 1,
  entries: {},
};

/**
 * Remembers turns that were accepted but have not finished, so a restart can run
 * them again instead of dropping them.
 *
 * The queue that executes turns is in-memory, so a deploy or a crash silently
 * loses whatever was queued or running. This is the durable half: an entry is
 * written before the turn is queued and removed once it settles, which makes
 * replay at-least-once. Callers are responsible for the "at least" part, either
 * by making the work idempotent or by checking whether its effects already
 * landed before running it again.
 */
export class TurnJournal {
  readonly #store: JsonFileStore<z.infer<typeof JournalStateSchema>>;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #maxAttempts: number;

  constructor(filePath: string, options: TurnJournalOptions = {}) {
    this.#store = new JsonFileStore(filePath, JournalStateSchema);
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = positiveInteger(
      options.maxAgeMs ?? 15 * 60_000,
      "maxAgeMs",
    );
    this.#maxAttempts = positiveInteger(
      options.maxAttempts ?? 3,
      "maxAttempts",
    );
  }

  /**
   * Records a turn as owed. Re-accepting a key already in the journal keeps its
   * original acceptance time and attempt count, so a replayed turn cannot renew
   * its own deadline and outlive the replay window.
   */
  async accept(key: string, payload: unknown): Promise<void> {
    const normalized = key.trim();
    if (!normalized) throw new Error("turn journal key is required");
    const parsed = JsonValueSchema.parse(payload);
    await this.#store.updateManaged((state) => {
      if (state.entries[normalized]) return state;
      return {
        ...state,
        entries: {
          ...state.entries,
          [normalized]: JournalEntrySchema.parse({
            key: normalized,
            payload: parsed,
            acceptedAt: iso(this.#now()),
            attempts: 0,
          }),
        },
      };
    }, DEFAULT_STATE);
  }

  async settle(key: string): Promise<void> {
    const normalized = key.trim();
    await this.#store.updateManaged((state) => {
      if (!state.entries[normalized]) return state;
      const entries = { ...state.entries };
      delete entries[normalized];
      return { ...state, entries };
    }, DEFAULT_STATE);
  }

  async pending(): Promise<TurnJournalEntry[]> {
    return Object.values((await this.#store.read(DEFAULT_STATE)).entries);
  }

  /**
   * Returns the turns worth running again, charging each one an attempt first.
   * The attempt is spent before the caller replays so a turn that crashes the
   * process still exhausts its budget, and entries stay in the journal until
   * they settle so a second crash mid-replay does not lose them.
   */
  async claimReplayable(): Promise<TurnJournalEntry[]> {
    const now = this.#now();
    let replayable: TurnJournalEntry[] = [];
    await this.#store.updateManaged((state) => {
      const entries: Record<string, TurnJournalEntry> = {};
      const claimed: TurnJournalEntry[] = [];
      for (const entry of Object.values(state.entries)) {
        const ageMs = now - Date.parse(entry.acceptedAt);
        if (!Number.isFinite(ageMs) || ageMs > this.#maxAgeMs) {
          log.warn("dropping turn older than the replay window", {
            key: entry.key,
            acceptedAt: entry.acceptedAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
          });
          continue;
        }
        const attempts = entry.attempts + 1;
        if (attempts > this.#maxAttempts) {
          log.error("giving up on a turn that never finished", {
            key: entry.key,
            acceptedAt: entry.acceptedAt,
            attempts: entry.attempts,
          });
          continue;
        }
        const next = JournalEntrySchema.parse({ ...entry, attempts });
        entries[entry.key] = next;
        claimed.push(next);
      }
      replayable = claimed;
      return { ...state, entries };
    }, DEFAULT_STATE);
    return replayable;
  }
}

export function turnJournalPath(dataDir: string): string {
  return join(dataDir, "state", "turn-journal.json");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`turn journal ${name} must be a positive integer`);
  }
  return value;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
