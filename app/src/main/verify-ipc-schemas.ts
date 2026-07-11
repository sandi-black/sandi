import assert from "node:assert/strict";

import { StagePasteSchema } from "./ipc-schemas";

for (const valid of [
  "data:image/png;base64,AA==",
  "data:image/jpeg;base64,AAA=",
  "data:image/webp;base64,TWFu",
]) {
  assert.equal(
    StagePasteSchema.safeParse(valid).success,
    true,
    `accepts canonical pasted image: ${valid}`,
  );
}

for (const invalid of [
  "data:image/gif;base64,AA==",
  "data:image/png;base64,AB==",
  "data:image/png;base64,AAB=",
  "data:image/png;base64,A===",
  "data:image/png;base64,AA=A",
  "data:image/png;base64,AAA",
  "data:image/png;base64,AA A",
  "data:image/png;base64,",
]) {
  assert.equal(
    StagePasteSchema.safeParse(invalid).success,
    false,
    `rejects malformed or noncanonical pasted image: ${invalid}`,
  );
}

const largeCanonicalPayload = `data:image/png;base64,${"A".repeat(6_000_000)}`;
assert.equal(
  StagePasteSchema.safeParse(largeCanonicalPayload).success,
  true,
  "validates a multi-megabyte payload iteratively without regex recursion",
);

console.log("verify-ipc-schemas: ok");
