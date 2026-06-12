import { createLogger } from "@/lib/logging";

const log = createLogger("thread-queue");

type QueuedJob = {
  name: string;
  run: (signal: AbortSignal) => Promise<void>;
};

type ActiveJob = {
  name: string;
  controller: AbortController;
};

type QueueState = {
  running: boolean;
  jobs: QueuedJob[];
  activeJob?: ActiveJob;
};

export type ThreadQueueStatus = {
  running: boolean;
  queuedJobs: number;
};

export class ThreadQueue {
  readonly #queues = new Map<string, QueueState>();

  status(threadKey: string): ThreadQueueStatus {
    const queue = this.#queues.get(threadKey);
    return {
      running: queue?.running ?? false,
      queuedJobs: queue?.jobs.length ?? 0,
    };
  }

  abortActive(threadKey: string): boolean {
    const activeJob = this.#queues.get(threadKey)?.activeJob;
    if (!activeJob || activeJob.controller.signal.aborted) return false;
    activeJob.controller.abort();
    log.info("thread job abort requested", {
      threadKey,
      job: activeJob.name,
    });
    return true;
  }

  enqueue(
    threadKey: string,
    name: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    const queue = this.#queues.get(threadKey) ?? { running: false, jobs: [] };
    queue.jobs.push({ name, run });
    this.#queues.set(threadKey, queue);
    if (!queue.running) {
      queue.running = true;
      void this.#drain(threadKey, queue);
    }
  }

  async #drain(threadKey: string, queue: QueueState): Promise<void> {
    while (queue.jobs.length > 0) {
      const job = queue.jobs.shift();
      if (!job) continue;
      const controller = new AbortController();
      queue.activeJob = { name: job.name, controller };
      try {
        await job.run(controller.signal);
      } catch (error) {
        log.error("thread job failed", {
          threadKey,
          job: job.name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        delete queue.activeJob;
      }
    }
    queue.running = false;
    if (queue.jobs.length === 0) {
      this.#queues.delete(threadKey);
    }
  }
}
