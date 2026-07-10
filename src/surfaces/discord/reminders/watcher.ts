import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import type { Reminder } from "@/surfaces/discord/reminders/schemas";
import { readReminder } from "@/surfaces/discord/reminders/store";

const log = createLogger("reminders");
const DEBOUNCE_MS = 200;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type ReminderTrigger = {
  id: string;
  reminder: Reminder;
};

export class ReminderWatcher {
  readonly #remindersRoot: string;
  readonly #onTrigger: (trigger: ReminderTrigger) => void;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #watcher: FSWatcher | undefined;

  constructor(
    remindersRoot: string,
    onTrigger: (trigger: ReminderTrigger) => void,
  ) {
    this.#remindersRoot = remindersRoot;
    this.#onTrigger = onTrigger;
  }

  async start(): Promise<void> {
    await mkdir(this.#remindersRoot, { recursive: true });
    await this.#scanExisting();
    this.#watcher = watch(this.#remindersRoot, (_eventType, filename) => {
      if (typeof filename !== "string" || !filename.endsWith(".json")) return;
      this.#debounce(filename, () => {
        void this.#handleFileChange(filename);
      });
    });
    log.info("watching reminders directory", {
      remindersRoot: this.#remindersRoot,
    });
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const timer of this.#debounceTimers.values()) clearTimeout(timer);
    this.#debounceTimers.clear();
  }

  async #scanExisting(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.#remindersRoot);
    } catch {
      return;
    }
    for (const filename of files) {
      if (filename.endsWith(".json")) await this.#handleFileChange(filename);
    }
  }

  #debounce(filename: string, run: () => void): void {
    const existing = this.#debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    this.#debounceTimers.set(
      filename,
      setTimeout(() => {
        this.#debounceTimers.delete(filename);
        run();
      }, DEBOUNCE_MS),
    );
  }

  async #handleFileChange(filename: string): Promise<void> {
    const id = filename.slice(0, -".json".length);
    const filepath = join(this.#remindersRoot, filename);
    if (!existsSync(filepath)) {
      this.#cancel(id);
      return;
    }

    let reminder: Reminder;
    try {
      reminder = await readReminder(this.#remindersRoot, id);
    } catch (error) {
      log.error("invalid reminder file", {
        id,
        error: errorMessage(error),
      });
      return;
    }

    this.#cancel(id);
    if (reminder.status !== "active") return;
    try {
      this.#schedule(id, reminder);
    } catch (error) {
      log.error("failed to schedule reminder", {
        id,
        error: errorMessage(error),
      });
    }
  }

  #schedule(id: string, reminder: Reminder): void {
    const targetTime = new Date(reminder.nextFireAt).getTime();
    if (!Number.isFinite(targetTime)) {
      throw new Error(`Invalid reminder timestamp: ${reminder.nextFireAt}`);
    }
    const delay = targetTime - Date.now();
    if (delay <= 0) {
      log.info("executing reminder", { id });
      this.#onTrigger({ id, reminder });
      return;
    }

    const actualDelay = Math.min(delay, MAX_TIMEOUT_MS);
    log.info("scheduling reminder", {
      id,
      targetDelaySec: Math.round(delay / 1000),
      actualDelaySec: Math.round(actualDelay / 1000),
    });
    const timer = setTimeout(() => {
      this.#timers.delete(id);
      this.#schedule(id, reminder);
    }, actualDelay);
    this.#timers.set(id, timer);
  }

  #cancel(id: string): void {
    const timer = this.#timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.#timers.delete(id);
  }
}
