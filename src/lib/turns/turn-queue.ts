import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";

const log = createLogger("thread-queue");

type QueuedJob = {
  name: string;
  run: (signal: AbortSignal) => Promise<void>;
  queued: boolean;
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

export type QueuedJobHandle = {
  // Removes work only while it is waiting. Once execution starts, callers use
  // abortActive because side effects may already be underway.
  cancel(): boolean;
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
  ): QueuedJobHandle {
    const queue = this.#queues.get(threadKey) ?? { running: false, jobs: [] };
    const job: QueuedJob = { name, run, queued: true };
    queue.jobs.push(job);
    this.#queues.set(threadKey, queue);
    if (!queue.running) {
      queue.running = true;
      void this.#drain(threadKey, queue);
    }
    return {
      cancel: () => {
        if (!job.queued) return false;
        const index = queue.jobs.indexOf(job);
        if (index < 0) return false;
        queue.jobs.splice(index, 1);
        job.queued = false;
        log.info("queued thread job canceled", { threadKey, job: name });
        return true;
      },
    };
  }

  async #drain(threadKey: string, queue: QueueState): Promise<void> {
    while (queue.jobs.length > 0) {
      const job = queue.jobs.shift();
      if (!job) continue;
      job.queued = false;
      const controller = new AbortController();
      queue.activeJob = { name: job.name, controller };
      try {
        await job.run(controller.signal);
      } catch (error) {
        log.error("thread job failed", {
          threadKey,
          job: job.name,
          error: errorMessage(error),
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
