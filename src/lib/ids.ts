import { randomUUID } from "node:crypto";

// Produces a sortable, human-scannable id for stored records (reminders,
// todos, events): a prefix for at-a-glance kind, a UTC timestamp for rough
// chronological ordering, and a short random suffix to avoid collisions
// within the same second. Callers treat the result as opaque; nothing
// should parse the stamp back out of a stored id.
export function generateTimestampId(prefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
  return `${prefix}_${stamp}_${randomUUID().slice(0, 8)}`;
}
