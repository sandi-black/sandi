import { join } from "node:path";

import { z } from "zod/v4";
import { JsonFileStore } from "@/lib/state/file-store";

const DreamStateSchema = z.object({
  version: z.literal(1),
  lastDreamAt: z.string().nullable(),
});

type DreamState = z.infer<typeof DreamStateSchema>;

const DEFAULT_STATE: DreamState = { version: 1, lastDreamAt: null };

// Tracks when Sandi last dreamed so a nightly sweep only consolidates episodic
// notes written since then. Persisted outside the memory root so it never shows
// up as a memory file or in the embedding index.
export class DreamStateStore {
  readonly #store: JsonFileStore<DreamState>;

  constructor(dataDir: string) {
    this.#store = new JsonFileStore(
      join(dataDir, "dreaming", "state.json"),
      DreamStateSchema,
    );
  }

  async lastDreamAt(): Promise<Date | null> {
    const state = await this.#store.read(DEFAULT_STATE);
    return state.lastDreamAt ? new Date(state.lastDreamAt) : null;
  }

  async setLastDreamAt(when: Date): Promise<void> {
    await this.#store.write({ version: 1, lastDreamAt: when.toISOString() });
  }
}
