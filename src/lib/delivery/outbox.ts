import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { JsonFileStore } from "@/lib/state/file-store";

const log = createLogger("delivery-outbox");
const JsonValueSchema = z.json();
const IsoDateTimeSchema = z.iso.datetime();
const ErrorClassSchema = z.enum(["transient", "ambiguous", "permanent"]);
const DeliveryErrorSchema = z.object({
  class: ErrorClassSchema,
  message: z.string().min(1),
  at: IsoDateTimeSchema,
});
const DeliveryClaimSchema = z.object({
  workerId: z.string().uuid(),
  leaseUntil: IsoDateTimeSchema,
});
const AmbiguitySchema = z.object({
  policy: z.literal("retry-same-idempotency-key"),
  count: z.number().int().positive(),
});
export const DeliveryRecordSchema = z.object({
  idempotencyKey: z.string().min(1),
  kind: z.string().min(1),
  payload: JsonValueSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  attempts: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  nextAttemptAt: IsoDateTimeSchema,
  progress: JsonValueSchema.optional(),
  result: JsonValueSchema.optional(),
  lastError: DeliveryErrorSchema.optional(),
  ambiguity: AmbiguitySchema.optional(),
  claim: DeliveryClaimSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
  failedAt: IsoDateTimeSchema.optional(),
});

const OutboxStateSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), DeliveryRecordSchema),
});

export type JsonValue = z.infer<typeof JsonValueSchema>;
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;
export type DeliveryStepResult =
  | { status: "complete"; result?: JsonValue }
  | { status: "progress"; progress: JsonValue };
export type DeliveryHandler = (
  record: DeliveryRecord,
  signal: AbortSignal,
) => Promise<DeliveryStepResult>;

export type OutboxOptions = {
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  claimLeaseMs?: number;
  pollMaxMs?: number;
};

type ActiveDelivery = {
  controller: AbortController;
  renewalTimer: ReturnType<typeof setInterval>;
  confirmedUntil: number;
};

const DEFAULT_STATE: z.infer<typeof OutboxStateSchema> = {
  version: 1,
  records: {},
};

export class AmbiguousDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AmbiguousDeliveryError";
  }
}

export class PermanentDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentDeliveryError";
  }
}

export class DurableOutbox {
  readonly #store: JsonFileStore<z.infer<typeof OutboxStateSchema>>;
  readonly #handlers = new Map<string, DeliveryHandler>();
  readonly #workerId = randomUUID();
  readonly #now: () => number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #claimLeaseMs: number;
  readonly #pollMaxMs: number;
  readonly #active = new Map<string, ActiveDelivery>();
  #running = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> | undefined;

  constructor(filePath: string, options: OutboxOptions = {}) {
    this.#store = new JsonFileStore(filePath, OutboxStateSchema);
    this.#now = options.now ?? Date.now;
    this.#retryBaseMs = positiveInteger(
      options.retryBaseMs ?? 1_000,
      "retryBaseMs",
    );
    this.#retryMaxMs = positiveInteger(
      options.retryMaxMs ?? 60 * 60_000,
      "retryMaxMs",
    );
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? 2 * 60_000,
      "claimLeaseMs",
    );
    this.#pollMaxMs = positiveInteger(options.pollMaxMs ?? 30_000, "pollMaxMs");
    if (this.#retryMaxMs < this.#retryBaseMs) {
      throw new Error("outbox retryMaxMs must be at least retryBaseMs");
    }
  }

  register(kind: string, handler: DeliveryHandler): void {
    const normalized = kind.trim();
    if (!normalized) throw new Error("outbox delivery kind must not be empty");
    if (this.#handlers.has(normalized)) {
      throw new Error(`outbox delivery kind already registered: ${normalized}`);
    }
    this.#handlers.set(normalized, handler);
    if (this.#running) this.#wake();
  }

  async enqueue(input: {
    idempotencyKey: string;
    kind: string;
    payload: unknown;
  }): Promise<DeliveryRecord> {
    const idempotencyKey = input.idempotencyKey.trim();
    const kind = input.kind.trim();
    if (!idempotencyKey) throw new Error("outbox idempotency key is required");
    if (!kind) throw new Error("outbox delivery kind is required");
    const payload = JsonValueSchema.parse(input.payload);
    const payloadHash = hashJson(payload);
    let record: DeliveryRecord | undefined;
    await this.#store.updateManaged((state) => {
      const existing = state.records[idempotencyKey];
      if (existing) {
        if (existing.kind !== kind || existing.payloadHash !== payloadHash) {
          throw new Error(
            `outbox idempotency key was reused with different work: ${idempotencyKey}`,
          );
        }
        record = existing;
        return state;
      }
      const now = iso(this.#now());
      const created = DeliveryRecordSchema.parse({
        idempotencyKey,
        kind,
        payload,
        payloadHash,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      });
      record = created;
      return {
        ...state,
        records: { ...state.records, [idempotencyKey]: created },
      };
    }, DEFAULT_STATE);
    if (!record) throw new Error("outbox enqueue did not produce a record");
    if (this.#running) this.#wake();
    return record;
  }

  async get(idempotencyKey: string): Promise<DeliveryRecord | undefined> {
    return (await this.#store.read(DEFAULT_STATE)).records[idempotencyKey];
  }

  async list(): Promise<DeliveryRecord[]> {
    return Object.values((await this.#store.read(DEFAULT_STATE)).records);
  }

  isDelivering(): boolean {
    return this.#active.size > 0;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#wake();
  }

  stop(): void {
    if (!this.#running && this.#active.size === 0) return;
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const active of this.#active.values()) {
      clearInterval(active.renewalTimer);
      active.controller.abort();
    }
  }

  async deliverNow(
    idempotencyKey: string,
  ): Promise<DeliveryRecord | undefined> {
    await this.#drain(idempotencyKey);
    return this.get(idempotencyKey);
  }

  async drainDue(): Promise<void> {
    await this.#drain();
  }

  async #drain(onlyKey?: string): Promise<void> {
    while (this.#draining) await this.#draining;
    const draining = this.#runDrain(onlyKey);
    this.#draining = draining;
    try {
      await draining;
    } finally {
      if (this.#draining === draining) this.#draining = undefined;
      if (this.#running) await this.#scheduleNext();
    }
  }

  async #runDrain(onlyKey?: string): Promise<void> {
    while (this.#running || onlyKey !== undefined) {
      const record = await this.#claimNext(onlyKey);
      if (!record) return;
      await this.#runClaimed(record);
    }
  }

  async #claimNext(onlyKey?: string): Promise<DeliveryRecord | undefined> {
    const supported = new Set(this.#handlers.keys());
    if (supported.size === 0) return undefined;
    let claimed: DeliveryRecord | undefined;
    await this.#store.updateManaged((state) => {
      const now = this.#now();
      const candidates = Object.values(state.records)
        .filter((record) => {
          if (onlyKey !== undefined && record.idempotencyKey !== onlyKey) {
            return false;
          }
          if (!supported.has(record.kind)) return false;
          if (record.status === "pending") {
            return timestamp(record.nextAttemptAt) <= now;
          }
          return (
            record.status === "processing" &&
            record.claim !== undefined &&
            timestamp(record.claim.leaseUntil) <= now
          );
        })
        .sort((left, right) =>
          left.nextAttemptAt.localeCompare(right.nextAttemptAt),
        );
      const selected = candidates[0];
      if (!selected) return state;
      const updated = DeliveryRecordSchema.parse({
        ...selected,
        status: "processing",
        attempts: selected.attempts + 1,
        updatedAt: iso(now),
        claim: {
          workerId: this.#workerId,
          leaseUntil: iso(now + this.#claimLeaseMs),
        },
      });
      claimed = updated;
      return {
        ...state,
        records: { ...state.records, [selected.idempotencyKey]: updated },
      };
    }, DEFAULT_STATE);
    return claimed;
  }

  async #runClaimed(record: DeliveryRecord): Promise<void> {
    const handler = this.#handlers.get(record.kind);
    if (!handler) return;
    const controller = new AbortController();
    const renewalMs = Math.max(1, Math.floor(this.#claimLeaseMs / 3));
    const active: ActiveDelivery = {
      controller,
      confirmedUntil: this.#now() + this.#claimLeaseMs,
      renewalTimer: setInterval(() => {
        void this.#renewClaim(record, active, renewalMs).catch(
          (error: unknown) => {
            log.error("delivery claim renewal failed", {
              idempotencyKey: record.idempotencyKey,
              error: errorMessage(error),
            });
            if (this.#now() + renewalMs >= active.confirmedUntil) {
              controller.abort(
                new Error("delivery claim could not be renewed safely"),
              );
            }
          },
        );
      }, renewalMs),
    };
    active.renewalTimer.unref?.();
    this.#active.set(record.idempotencyKey, active);
    try {
      const result = await handler(record, controller.signal);
      await this.#settleSuccess(record, result);
    } catch (error) {
      await this.#settleError(record, error);
    } finally {
      clearInterval(active.renewalTimer);
      this.#active.delete(record.idempotencyKey);
    }
  }

  async #renewClaim(
    record: DeliveryRecord,
    active: ActiveDelivery,
    renewalMs: number,
  ): Promise<void> {
    const now = this.#now();
    let renewed = false;
    await this.#store.updateManaged((state) => {
      const current = state.records[record.idempotencyKey];
      if (
        current?.status !== "processing" ||
        current.claim?.workerId !== this.#workerId
      ) {
        return state;
      }
      renewed = true;
      const next = DeliveryRecordSchema.parse({
        ...current,
        updatedAt: iso(now),
        claim: {
          workerId: this.#workerId,
          leaseUntil: iso(now + this.#claimLeaseMs),
        },
      });
      return {
        ...state,
        records: { ...state.records, [record.idempotencyKey]: next },
      };
    }, DEFAULT_STATE);
    if (renewed) {
      active.confirmedUntil = now + this.#claimLeaseMs;
      return;
    }
    if (now + renewalMs >= active.confirmedUntil) {
      active.controller.abort(new Error("delivery claim ownership was lost"));
    }
  }

  async #settleSuccess(
    record: DeliveryRecord,
    result: DeliveryStepResult,
  ): Promise<void> {
    const now = this.#now();
    await this.#updateOwned(record, (current) => {
      if (result.status === "progress") {
        return DeliveryRecordSchema.parse({
          ...current,
          status: "pending",
          progress: JsonValueSchema.parse(result.progress),
          updatedAt: iso(now),
          nextAttemptAt: iso(now),
          claim: undefined,
          lastError: undefined,
        });
      }
      return DeliveryRecordSchema.parse({
        ...current,
        status: "completed",
        payload: null,
        updatedAt: iso(now),
        completedAt: iso(now),
        claim: undefined,
        lastError: undefined,
        progress: undefined,
        ...(result.result !== undefined
          ? { result: JsonValueSchema.parse(result.result) }
          : {}),
      });
    });
  }

  async #settleError(record: DeliveryRecord, error: unknown): Promise<void> {
    const now = this.#now();
    const classification = classifyError(error);
    await this.#updateOwned(record, (current) => {
      const lastError = {
        class: classification,
        message: errorMessage(error),
        at: iso(now),
      };
      if (classification === "permanent") {
        return DeliveryRecordSchema.parse({
          ...current,
          status: "failed",
          updatedAt: iso(now),
          failedAt: iso(now),
          claim: undefined,
          lastError,
        });
      }
      const ambiguity =
        classification === "ambiguous"
          ? {
              policy: "retry-same-idempotency-key" as const,
              count: (current.ambiguity?.count ?? 0) + 1,
            }
          : current.ambiguity;
      return DeliveryRecordSchema.parse({
        ...current,
        status: "pending",
        updatedAt: iso(now),
        nextAttemptAt: iso(now + this.#retryDelay(current.attempts)),
        claim: undefined,
        lastError,
        ...(ambiguity ? { ambiguity } : {}),
      });
    });
    log.warn("delivery attempt failed", {
      idempotencyKey: record.idempotencyKey,
      kind: record.kind,
      classification,
      error: errorMessage(error),
    });
  }

  async #updateOwned(
    record: DeliveryRecord,
    update: (current: DeliveryRecord) => DeliveryRecord,
  ): Promise<void> {
    await this.#store.updateManaged((state) => {
      const current = state.records[record.idempotencyKey];
      if (
        current?.status !== "processing" ||
        current.claim?.workerId !== this.#workerId
      ) {
        return state;
      }
      const next = update(current);
      return {
        ...state,
        records: { ...state.records, [record.idempotencyKey]: next },
      };
    }, DEFAULT_STATE);
  }

  #retryDelay(attempts: number): number {
    const exponent = Math.max(0, Math.min(20, attempts - 1));
    return Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** exponent);
  }

  #wake(): void {
    if (!this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain().catch((error: unknown) => {
        log.error("delivery outbox drain failed", {
          error: errorMessage(error),
        });
        if (this.#running) this.#wakeLater(this.#pollMaxMs);
      });
    }, 0);
  }

  async #scheduleNext(): Promise<void> {
    if (!this.#running || this.#timer) return;
    const now = this.#now();
    const supported = new Set(this.#handlers.keys());
    const state = await this.#store.read(DEFAULT_STATE);
    let nextAt = now + this.#pollMaxMs;
    for (const record of Object.values(state.records)) {
      if (!supported.has(record.kind)) continue;
      if (record.status === "pending") {
        nextAt = Math.min(nextAt, timestamp(record.nextAttemptAt));
      } else if (record.status === "processing" && record.claim) {
        nextAt = Math.min(nextAt, timestamp(record.claim.leaseUntil));
      }
    }
    this.#wakeLater(Math.max(0, Math.min(this.#pollMaxMs, nextAt - now)));
  }

  #wakeLater(delayMs: number): void {
    if (!this.#running || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain().catch((error: unknown) => {
        log.error("delivery outbox drain failed", {
          error: errorMessage(error),
        });
      });
    }, delayMs);
    this.#timer.unref?.();
  }
}

export function deliveryOutboxPath(dataDir: string): string {
  return join(dataDir, "state", "delivery-outbox.json");
}

function classifyError(error: unknown): z.infer<typeof ErrorClassSchema> {
  if (error instanceof PermanentDeliveryError) return "permanent";
  if (error instanceof AmbiguousDeliveryError) return "ambiguous";
  if (error instanceof z.ZodError) return "permanent";
  return "transient";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`outbox ${name} must be a positive integer`);
  }
  return value;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
