import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Cron } from "croner";

import { errorMessage } from "@/lib/errors";
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
};

export class EventWatcher {
  readonly #eventsRoot: string;
  readonly #onTrigger: (trigger: EventTrigger) => void;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #crons = new Map<string, Cron>();
  readonly #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #watcher: FSWatcher | undefined;

  constructor(eventsRoot: string, onTrigger: (trigger: EventTrigger) => void) {
    this.#eventsRoot = eventsRoot;
    this.#onTrigger = onTrigger;
  }

  async start(): Promise<void> {
    await mkdir(this.#eventsRoot, { recursive: true });
    await this.#scanExisting();
    this.#watcher = watch(this.#eventsRoot, (_eventType, filename) => {
      if (typeof filename !== "string" || !filename.endsWith(".json")) return;
      this.#debounce(filename, () => {
        void this.#handleFileChange(filename);
      });
    });
    log.info("watching events directory", { eventsRoot: this.#eventsRoot });
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const cron of this.#crons.values()) cron.stop();
    this.#crons.clear();
    for (const timer of this.#debounceTimers.values()) clearTimeout(timer);
    this.#debounceTimers.clear();
  }

  async #scanExisting(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.#eventsRoot);
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
    const filepath = join(this.#eventsRoot, filename);
    if (!existsSync(filepath)) {
      this.#cancel(id);
      return;
    }

    let event: SandiEvent;
    try {
      event = await readEvent(this.#eventsRoot, id);
    } catch (error) {
      log.error("invalid event file", {
        id,
        error: errorMessage(error),
      });
      return;
    }

    this.#cancel(id);
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
    switch (event.type) {
      case "immediate":
        this.#triggerAndDelete(id, event, `[EVENT:${id}:immediate]`);
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
      this.#triggerAndDelete(id, event, `[EVENT:${id}:one-shot:overdue]`);
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
    const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
      this.#onTrigger({
        id,
        event,
        label: `[EVENT:${id}:periodic:${event.schedule}]`,
      });
    });
    this.#crons.set(id, cron);
  }

  #triggerAndDelete(id: string, event: SandiEvent, label: string): void {
    log.info("executing event", { id, type: event.type });
    this.#onTrigger({ id, event, label });
    void deleteEvent(this.#eventsRoot, id);
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
  }
}
