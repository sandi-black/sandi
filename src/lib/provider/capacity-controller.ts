import type {
  ModelProviderClient,
  ProviderProbe,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";

export type ProviderCapacityConfig = {
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedPerIdentity: number;
  shutdownGraceMs: number;
};

export const DEFAULT_PROVIDER_CAPACITY: ProviderCapacityConfig = {
  maxConcurrent: 3,
  maxQueued: 64,
  maxQueuedPerIdentity: 8,
  shutdownGraceMs: 5_000,
};

export type ProviderCapacityRejection =
  | "overloaded"
  | "identity_overloaded"
  | "passive_coalesced"
  | "title_discarded"
  | "shutting_down"
  | "aborted";

export class ProviderCapacityError extends Error {
  readonly reason: ProviderCapacityRejection;

  constructor(reason: ProviderCapacityRejection) {
    super(`provider work rejected: ${reason}`);
    this.name = "ProviderCapacityError";
    this.reason = reason;
  }
}

type WorkKind = "interactive" | "passive" | "background" | "title";
type QueuedWork = {
  sequence: number;
  kind: WorkKind;
  identityId: string;
  request: ProviderTurnRequest;
  resolve(value: ProviderTurnResponse): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
};

export class CapacityControlledProvider implements ModelProviderClient {
  readonly #provider: ModelProviderClient;
  readonly #config: ProviderCapacityConfig;
  readonly #queue: QueuedWork[] = [];
  readonly #active = new Set<AbortController>();
  readonly #idleWaiters = new Set<() => void>();
  #accepting = true;
  #sequence = 0;
  #interactiveStreak = 0;

  constructor(
    provider: ModelProviderClient,
    config: ProviderCapacityConfig = DEFAULT_PROVIDER_CAPACITY,
  ) {
    validateConfig(config);
    this.#provider = provider;
    this.#config = config;
  }

  probe(): Promise<ProviderProbe> {
    return this.#provider.probe();
  }

  generateTurn(request: ProviderTurnRequest): Promise<ProviderTurnResponse> {
    if (!this.#accepting) {
      return Promise.reject(new ProviderCapacityError("shutting_down"));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new ProviderCapacityError("aborted"));
    }

    const kind = workKind(request);
    const identityId = request.accountRouting?.identityId ?? "unrouted";
    if (kind === "passive" && this.#hasQueued(kind, identityId)) {
      return Promise.reject(new ProviderCapacityError("passive_coalesced"));
    }
    if (kind === "title" && this.#underPressure()) {
      return Promise.reject(new ProviderCapacityError("title_discarded"));
    }
    if (this.#queue.length >= this.#config.maxQueued) {
      return Promise.reject(new ProviderCapacityError("overloaded"));
    }
    if (
      this.#queuedForIdentity(identityId) >= this.#config.maxQueuedPerIdentity
    ) {
      return Promise.reject(new ProviderCapacityError("identity_overloaded"));
    }

    return new Promise<ProviderTurnResponse>((resolve, reject) => {
      let work: QueuedWork;
      const onAbort = (): void => {
        const index = this.#queue.indexOf(work);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        work.removeAbortListener();
        reject(new ProviderCapacityError("aborted"));
        this.#notifyIdle();
      };
      const removeAbortListener = (): void =>
        request.signal?.removeEventListener("abort", onAbort);
      work = {
        sequence: this.#sequence++,
        kind,
        identityId,
        request,
        resolve,
        reject,
        removeAbortListener,
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(work);
      this.#pump();
    });
  }

  async shutdown(
    graceMs: number = this.#config.shutdownGraceMs,
  ): Promise<void> {
    this.#accepting = false;
    for (const work of this.#queue.splice(0)) {
      work.removeAbortListener();
      work.reject(new ProviderCapacityError("shutting_down"));
    }
    if (this.#active.size === 0) return;
    const timer = setTimeout(() => {
      for (const controller of this.#active) controller.abort();
    }, graceMs);
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    clearTimeout(timer);
  }

  status(): { active: number; queued: number; accepting: boolean } {
    return {
      active: this.#active.size,
      queued: this.#queue.length,
      accepting: this.#accepting,
    };
  }

  #pump(): void {
    while (
      this.#accepting &&
      this.#active.size < this.#config.maxConcurrent &&
      this.#queue.length > 0
    ) {
      const work = this.#takeNext();
      if (!work) return;
      work.removeAbortListener();
      const controller = new AbortController();
      this.#active.add(controller);
      const signal = work.request.signal
        ? AbortSignal.any([work.request.signal, controller.signal])
        : controller.signal;
      void Promise.resolve()
        .then(() => this.#provider.generateTurn({ ...work.request, signal }))
        .then(
          (response) => {
            work.resolve(response);
            this.#finish(controller);
          },
          (error: unknown) => {
            work.reject(error);
            this.#finish(controller);
          },
        );
    }
  }

  #finish(controller: AbortController): void {
    if (this.#active.delete(controller)) {
      this.#pump();
      this.#notifyIdle();
    }
  }

  #takeNext(): QueuedWork | undefined {
    const hasNonInteractive = this.#queue.some(
      (work) => work.kind !== "interactive",
    );
    let index: number;
    if (this.#interactiveStreak >= 4 && hasNonInteractive) {
      index = this.#oldestIndex((work) => work.kind !== "interactive");
    } else {
      const priority = Math.min(
        ...this.#queue.map((work) => priorityOf(work.kind)),
      );
      index = this.#oldestIndex((work) => priorityOf(work.kind) === priority);
    }
    const [work] = this.#queue.splice(index, 1);
    if (!work) return undefined;
    this.#interactiveStreak =
      work.kind === "interactive" ? this.#interactiveStreak + 1 : 0;
    return work;
  }

  #oldestIndex(predicate: (work: QueuedWork) => boolean): number {
    let chosen = -1;
    let sequence = Number.POSITIVE_INFINITY;
    for (const [index, work] of this.#queue.entries()) {
      if (predicate(work) && work.sequence < sequence) {
        chosen = index;
        sequence = work.sequence;
      }
    }
    return chosen;
  }

  #underPressure(): boolean {
    return (
      this.#queue.some((work) => work.kind === "interactive") ||
      this.#queue.length >= Math.ceil(this.#config.maxQueued / 2)
    );
  }

  #hasQueued(kind: WorkKind, identityId: string): boolean {
    return this.#queue.some(
      (work) => work.kind === kind && work.identityId === identityId,
    );
  }

  #queuedForIdentity(identityId: string): number {
    return this.#queue.filter((work) => work.identityId === identityId).length;
  }

  #notifyIdle(): void {
    if (this.#active.size > 0 || this.#queue.length > 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

function workKind(request: ProviderTurnRequest): WorkKind {
  if (
    request.conversationId.startsWith("title:") ||
    request.conversationId.startsWith("thread-title:")
  ) {
    return "title";
  }
  if (request.conversationId.startsWith("passive-gate:")) return "passive";
  if (
    request.conversationId.startsWith("dream:") ||
    request.conversationId.startsWith("dream-encode:")
  ) {
    return "background";
  }
  return "interactive";
}

function priorityOf(kind: WorkKind): number {
  if (kind === "interactive") return 0;
  if (kind === "passive") return 1;
  if (kind === "background") return 2;
  return 3;
}

function validateConfig(config: ProviderCapacityConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`provider capacity ${name} must be a positive integer`);
    }
  }
}
