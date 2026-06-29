import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const IsoDateTime = z
  .string()
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "must be an ISO datetime",
  );

const DreamStateSchema = z.object({
  version: z.literal(1),
  // The time each conversation was last dreamed, keyed by canonical id. A
  // conversation advances only when its own dream succeeds, so a failure retries
  // in isolation rather than being masked by a global watermark.
  conversations: z.record(z.string(), IsoDateTime),
});

type DreamState = z.infer<typeof DreamStateSchema>;

const DEFAULT_STATE: DreamState = { version: 1, conversations: {} };

// Tracks when each conversation was last dreamed so a nightly sweep only
// consolidates episodic notes written since then. Persisted outside the memory
// root so it never shows up as a memory file or in the embedding index.
export class DreamStateStore {
  readonly #store: JsonFileStore<DreamState>;

  constructor(dataDir: string) {
    this.#store = new JsonFileStore(
      join(dataDir, "dreaming", "state.json"),
      DreamStateSchema,
    );
  }

  async lastDreamAt(conversationId: string): Promise<Date | null> {
    const state = await this.#store.read(DEFAULT_STATE);
    const value = state.conversations[conversationId];
    return value ? new Date(value) : null;
  }

  async markDreamed(conversationId: string, when: Date): Promise<void> {
    await this.#store.updateManaged(
      (current) => ({
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: when.toISOString(),
        },
      }),
      DEFAULT_STATE,
    );
  }
}
