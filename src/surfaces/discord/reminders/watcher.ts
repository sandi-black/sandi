import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";

import { errorMessage } from "@/lib/errors";
import { isMissingPathError } from "@/lib/fs-errors";
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
  readonly #triggeredDueAt = new Map<string, string>();
  #watcher: FSWatcher | undefined;
  #running = false;
  #generation = 0;

  constructor(
    remindersRoot: string,
    onTrigger: (trigger: ReminderTrigger) => void,
  ) {
    this.#remindersRoot = remindersRoot;
    this.#onTrigger = onTrigger;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    const generation = ++this.#generation;
    this.#running = true;
    try {
      await mkdir(this.#remindersRoot, { recursive: true });
      if (!this.#running || generation !== this.#generation) return;
      this.#watcher = watch(this.#remindersRoot, (_eventType, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".json")) {
          return;
        }
        this.#debounce(filename, () => {
          void this.#handleFileChange(filename);
        });
      });
      this.#watcher.on("error", (error) => {
        log.error("reminders directory watcher failed", {
          remindersRoot: this.#remindersRoot,
          error: errorMessage(error),
        });
        this.stop();
      });
      await this.#scanExisting();
    } catch (error) {
      this.stop();
      throw error;
    }
    log.info("watching reminders directory", {
      remindersRoot: this.#remindersRoot,
    });
  }

  stop(): void {
    this.#generation += 1;
    this.#running = false;
    this.#watcher?.close();
    this.#watcher = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#triggeredDueAt.clear();
    for (const timer of this.#debounceTimers.values()) clearTimeout(timer);
    this.#debounceTimers.clear();
  }

  async #scanExisting(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.#remindersRoot);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    for (const filename of files) {
      if (filename.endsWith(".json")) await this.#handleFileChange(filename);
    }
  }

  #debounce(filename: string, run: () => void): void {
    if (!this.#running) return;
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
    if (!this.#running) return;
    const id = filename.slice(0, -".json".length);
    this.#cancel(id);

    let reminder: Reminder;
    try {
      reminder = await readReminder(this.#remindersRoot, id);
    } catch (error) {
      if (isMissingPathError(error)) {
        this.#triggeredDueAt.delete(id);
        return;
      }
      log.error("invalid reminder file", {
        id,
        error: errorMessage(error),
      });
      return;
    }

    if (!this.#running) return;
    if (reminder.status !== "active") {
      this.#triggeredDueAt.delete(id);
      return;
    }
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
    if (!this.#running) return;
    const targetTime = new Date(reminder.nextFireAt).getTime();
    if (!Number.isFinite(targetTime)) {
      throw new Error(`Invalid reminder timestamp: ${reminder.nextFireAt}`);
    }
    const delay = targetTime - Date.now();
    if (delay <= 0) {
      if (this.#triggeredDueAt.get(id) === reminder.nextFireAt) return;
      this.#triggeredDueAt.set(id, reminder.nextFireAt);
      log.info("executing reminder", { id });
      this.#onTrigger({ id, reminder });
      return;
    }
    this.#triggeredDueAt.delete(id);

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
