/**
 * A fixed-window request counter with both a per-client and a global cap.
 * In-memory and per-process, which is all the pairing endpoint needs: the caps
 * are a coarse flood guard, not an accounting system. Each window resets in one
 * step once it expires.
 */
export class FixedWindowLimiter {
  readonly #windowMs: number;
  readonly #maxPerClient: number;
  readonly #maxGlobal: number;
  readonly #clients = new Map<string, { count: number; resetAt: number }>();
  #global = { count: 0, resetAt: 0 };

  constructor(windowMs: number, maxPerClient: number, maxGlobal: number) {
    this.#windowMs = windowMs;
    this.#maxPerClient = maxPerClient;
    this.#maxGlobal = maxGlobal;
  }

  tryConsume(key: string, now: number = Date.now()): boolean {
    if (now >= this.#global.resetAt) {
      this.#global = { count: 0, resetAt: now + this.#windowMs };
      this.#sweep(now);
    }
    if (this.#global.count >= this.#maxGlobal) return false;

    const existing = this.#clients.get(key);
    const client =
      existing && now < existing.resetAt
        ? existing
        : { count: 0, resetAt: now + this.#windowMs };
    if (client.count >= this.#maxPerClient) return false;

    client.count += 1;
    this.#global.count += 1;
    this.#clients.set(key, client);
    return true;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#clients) {
      if (now >= entry.resetAt) this.#clients.delete(key);
    }
  }
}
