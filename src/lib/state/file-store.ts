import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import type { z } from "zod/v4";
import {
  chmodPrivateFile,
  writePrivateTextFile,
} from "@/lib/state/private-files";

export class JsonFileStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  #lastWrite: Promise<void> = Promise.resolve();

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
    this.#lastWrite = this.#lastWrite.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tempPath = `${this.#path}.tmp`;
      await writePrivateTextFile(
        tempPath,
        `${JSON.stringify(parsed, null, 2)}\n`,
      );
      await rename(tempPath, this.#path);
      await chmodPrivateFile(this.#path);
    });
    await this.#lastWrite;
  }

  async update(
    mutator: (current: T) => T | Promise<T>,
    defaultValue: T,
  ): Promise<T> {
    const current = await this.read(defaultValue);
    const next = await mutator(current);
    await this.write(next);
    return next;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
