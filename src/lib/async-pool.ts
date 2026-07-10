/**
 * Promise.allSettled with a concurrency cap: at most `limit` runs are in
 * flight at once, and results land at the same index as their input item.
 * Use this instead of a bare allSettled(map(...)) when each run consumes a
 * bounded resource (a subprocess, a rate-limited API) that an unbounded
 * burst would exhaust.
 */
export async function mapSettledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const entries = items.map((item, index) => ({ item, index }));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const entry = entries[next];
      next += 1;
      if (!entry) return;
      try {
        const value = await run(entry.item, entry.index);
        results[entry.index] = { status: "fulfilled", value };
      } catch (reason) {
        results[entry.index] = { status: "rejected", reason };
      }
    }
  };
  const workerCount = Math.max(1, Math.min(limit, entries.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
