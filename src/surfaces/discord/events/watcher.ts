import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";

import { Cron } from "croner";

import { errorMessage } from "@/lib/errors";
import { isMissingPathError } from "@/lib/fs-errors";
import { createLogger } from "@/lib/logging";
import type { SandiEvent } from "@/surfaces/discord/events/schemas";
import { deleteEvent, readEvent } from "@/surfaces/discord/events/store";

const log = createLogger("events");
const DEBOUNCE_MS = 200;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type EventTrigger = {
  id: string;
  event: SandiEvent;
  label: string;
  occurrence: string;
};

export class EventWatcher {
  readonly #eventsRoot: string;
  readonly #onTrigger: (trigger: EventTrigger) => Promise<void>;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #crons = new Map<string, Cron>();
  readonly #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #triggerRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  #watcher: FSWatcher | undefined;
  #running = false;
  #generation = 0;

  constructor(
    eventsRoot: string,
    onTrigger: (trigger: EventTrigger) => Promise<void>,
  ) {
    this.#eventsRoot = eventsRoot;
    this.#onTrigger = onTrigger;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    const generation = ++this.#generation;
    this.#running = true;
    try {
      await mkdir(this.#eventsRoot, { recursive: true });
      if (!this.#running || generation !== this.#generation) return;
      // Install the watcher before scanning so a file created between readdir
      // and watch registration cannot remain invisible until restart.
      this.#watcher = watch(this.#eventsRoot, (_eventType, filename) => {
        if (typeof filename !== "string" || !filename.endsWith(".json")) {
          return;
        }
        this.#debounce(filename, () => {
          void this.#handleFileChange(filename);
        });
      });
      this.#watcher.on("error", (error) => {
        log.error("events directory watcher failed", {
          eventsRoot: this.#eventsRoot,
          error: errorMessage(error),
        });
        this.stop();
      });
      await this.#scanExisting();
    } catch (error) {
      this.stop();
      throw error;
    }
    log.info("watching events directory", { eventsRoot: this.#eventsRoot });
  }

  stop(): void {
    this.#generation += 1;
    this.#running = false;
    this.#watcher?.close();
    this.#watcher = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const cron of this.#crons.values()) cron.stop();
    this.#crons.clear();
    for (const timer of this.#debounceTimers.values()) clearTimeout(timer);
    this.#debounceTimers.clear();
    for (const timer of this.#triggerRetryTimers.values()) clearTimeout(timer);
    this.#triggerRetryTimers.clear();
  }

  async #scanExisting(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.#eventsRoot);
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
    // A malformed replacement must fail closed instead of leaving the prior
    // valid schedule active.
    this.#cancel(id);

    let event: SandiEvent;
    try {
      event = await readEvent(this.#eventsRoot, id);
    } catch (error) {
      if (isMissingPathError(error)) return;
      log.error("invalid event file", {
        id,
        error: errorMessage(error),
      });
      return;
    }

    if (!this.#running) return;
    try {
      this.#schedule(id, event);
    } catch (error) {
      log.error("failed to schedule event", {
        id,
        error: errorMessage(error),
      });
    }
  }

  #schedule(id: string, event: SandiEvent): void {
    if (!this.#running) return;
    switch (event.type) {
      case "immediate":
        void this.#triggerAndDelete(id, event, `[EVENT:${id}:immediate]`);
        return;
      case "one-shot":
        this.#scheduleOneShot(id, event);
        return;
      case "periodic":
        this.#schedulePeriodic(id, event);
        return;
    }
  }

  #scheduleOneShot(
    id: string,
    event: Extract<SandiEvent, { type: "one-shot" }>,
  ) {
    const targetTime = new Date(event.at).getTime();
    if (!Number.isFinite(targetTime)) {
      throw new Error(`Invalid one-shot event timestamp: ${event.at}`);
    }
    const delay = targetTime - Date.now();
    if (delay <= 0) {
      void this.#triggerAndDelete(id, event, `[EVENT:${id}:one-shot:overdue]`);
      return;
    }

    const actualDelay = Math.min(delay, MAX_TIMEOUT_MS);
    log.info("scheduling one-shot event", {
      id,
      targetDelaySec: Math.round(delay / 1000),
      actualDelaySec: Math.round(actualDelay / 1000),
    });
    const timer = setTimeout(() => {
      this.#timers.delete(id);
      this.#scheduleOneShot(id, event);
    }, actualDelay);
    this.#timers.set(id, timer);
  }

  #schedulePeriodic(
    id: string,
    event: Extract<SandiEvent, { type: "periodic" }>,
  ) {
    log.info("scheduling periodic event", {
      id,
      schedule: event.schedule,
      timezone: event.timezone,
    });
    const cron = new Cron(
      event.schedule,
      { timezone: event.timezone },
      (self) => {
        if (!this.#running) return;
        const occurrence = (self.currentRun() ?? new Date()).toISOString();
        this.#triggerPeriodic({
          id,
          event,
          label: `[EVENT:${id}:periodic:${event.schedule}]`,
          occurrence,
        });
      },
    );
    this.#crons.set(id, cron);
  }

  #triggerPeriodic(trigger: EventTrigger): void {
    const retryKey = `${trigger.id}:${trigger.occurrence}`;
    void this.#onTrigger(trigger).catch((error: unknown) => {
      log.error("failed to persist periodic event delivery", {
        id: trigger.id,
        occurrence: trigger.occurrence,
        error: errorMessage(error),
      });
      this.#scheduleTriggerRetry(retryKey, () =>
        this.#triggerPeriodic(trigger),
      );
    });
  }

  async #triggerAndDelete(
    id: string,
    event: SandiEvent,
    label: string,
  ): Promise<void> {
    if (!this.#running) return;
    log.info("executing event", { id, type: event.type });
    const occurrence = event.type === "one-shot" ? event.at : event.createdAt;
    try {
      await this.#onTrigger({ id, event, label, occurrence });
      await deleteEvent(this.#eventsRoot, id);
    } catch (error) {
      log.error("failed to persist or delete triggered event", {
        id,
        error: errorMessage(error),
      });
      this.#scheduleTriggerRetry(`${id}:${occurrence}`, () => {
        void this.#triggerAndDelete(id, event, label);
      });
    }
  }

  #scheduleTriggerRetry(key: string, retry: () => void): void {
    if (!this.#running || this.#triggerRetryTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.#triggerRetryTimers.delete(key);
      retry();
    }, 1_000);
    this.#triggerRetryTimers.set(key, timer);
  }

  #cancel(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
    const cron = this.#crons.get(id);
    if (cron) {
      cron.stop();
      this.#crons.delete(id);
    }
    for (const [key, retry] of this.#triggerRetryTimers) {
      if (!key.startsWith(`${id}:`)) continue;
      clearTimeout(retry);
      this.#triggerRetryTimers.delete(key);
    }
  }
}
