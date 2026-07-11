import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import type { z } from "zod/v4";
import { isMissingFileError } from "@/lib/fs-errors";
import { withManagedWrite } from "@/lib/state/managed-write";
import {
  chmodPrivateFile,
  writePrivateTextFile,
} from "@/lib/state/private-files";

export class JsonFileStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;

  constructor(path: string, schema: z.ZodType<T>) {
    this.#path = path;
    this.#schema = schema;
  }

  async read(defaultValue: T): Promise<T> {
    try {
      const raw = await readFile(this.#path, "utf8");
      return this.#schema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) return defaultValue;
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const parsed = this.#schema.parse(value);
    await withManagedWrite(this.#path, () => this.#writeParsed(parsed));
  }

  /**
   * Read-modify-write that is NOT atomic across the read/write gap. Same-process
   * callers should prefer updateManaged, which runs the whole read, mutate, and
   * write inside one cross-process lock so concurrent processes cannot lose
   * updates.
   */
  async update(
    mutator: (current: T) => T | Promise<T>,
    defaultValue: T,
  ): Promise<T> {
    const current = await this.read(defaultValue);
    const next = await mutator(current);
    await this.write(next);
    return next;
  }

  /**
   * Serializes the entire read, mutate, and write under one managed-write lock,
   * so concurrent same-identity processes cannot lose updates to managed state.
   */
  async updateManaged(
    mutator: (current: T) => T | Promise<T>,
    defaultValue: T,
  ): Promise<T> {
    return withManagedWrite(this.#path, async () => {
      const current = await this.read(defaultValue);
      const next = await mutator(current);
      // Returning the current object is the mutator's no-change result. Avoid
      // rewriting shared state for duplicate notifications and empty drains.
      if (next === current) return current;
      const parsed = this.#schema.parse(next);
      await this.#writeParsed(parsed);
      return parsed;
    });
  }

  async #writeParsed(parsed: T): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tempPath = `${this.#path}.tmp`;
    await writePrivateTextFile(
      tempPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    await rename(tempPath, this.#path);
    await chmodPrivateFile(this.#path);
  }
}
