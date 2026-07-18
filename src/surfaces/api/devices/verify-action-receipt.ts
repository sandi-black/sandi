import assert from "node:assert/strict";

import {
  ACTION_RECEIPT_STDOUT_PREFIX,
  ActionReceiptSchema,
  buildActionReceipt,
  extractActionReceipt,
  formatActionReceipt,
  MAX_ACTION_RECEIPT_JSON_CHARS,
  parseActionReceipt,
} from "@/surfaces/api/devices/action-receipt";

const succeeded = buildActionReceipt({
  action: "set-value",
  method: "uia-value-pattern",
  target: {
    pid: 1234,
    hwnd: "5678",
    control: { kind: "uia-path", path: "0/2" },
  },
  observation: {
    status: "fresh",
    observedAt: "2026-07-18T18:00:00.000Z",
  },
  execution: { status: "completed", result: { status: "succeeded" } },
  verification: {
    status: "succeeded",
    basis: "post-action",
    observedAt: "2026-07-18T18:00:01.000Z",
  },
  cleanup: { status: "not-required" },
});

assert.deepEqual(parseActionReceipt(succeeded), succeeded);
assert.equal(
  formatActionReceipt(succeeded),
  "set-value via uia-value-pattern on pid 1234 hwnd 5678 control 0/2: execution succeeded; verification succeeded (post-action); cleanup not-required",
);

const emitted = extractActionReceipt(
  [
    "ordinary output",
    `${ACTION_RECEIPT_STDOUT_PREFIX}${JSON.stringify(succeeded)}`,
    "more ordinary output",
  ].join("\n"),
);
assert.equal(emitted.status, "parsed");
if (emitted.status === "parsed") {
  assert.deepEqual(emitted.receipt, succeeded);
  assert.equal(emitted.stdout, "ordinary output\nmore ordinary output");
}

const malformed = extractActionReceipt(`${ACTION_RECEIPT_STDOUT_PREFIX}{`);
assert.equal(malformed.status, "invalid");
assert.equal(malformed.stdout, "");

const repeated = extractActionReceipt(
  `${ACTION_RECEIPT_STDOUT_PREFIX}${JSON.stringify(succeeded)}\n${ACTION_RECEIPT_STDOUT_PREFIX}${JSON.stringify(succeeded)}`,
);
assert.equal(repeated.status, "invalid");

const oversized = extractActionReceipt(
  `${ACTION_RECEIPT_STDOUT_PREFIX}${"x".repeat(MAX_ACTION_RECEIPT_JSON_CHARS + 1)}`,
);
assert.equal(oversized.status, "invalid");

assert.equal(
  ActionReceiptSchema.safeParse({
    ...succeeded,
    target: { ...succeeded.target, text: "private document content" },
  }).success,
  false,
  "target fields cannot carry document content",
);
assert.equal(
  ActionReceiptSchema.safeParse({
    ...succeeded,
    value: "clipboard or credential content",
  }).success,
  false,
  "the receipt root rejects raw values",
);
const callerMustObserve = buildActionReceipt({
  ...succeeded,
  verification: {
    status: "not-performed",
    reason: "caller-observation-required",
  },
});
assert.match(
  formatActionReceipt(callerMustObserve),
  /execution succeeded; verification not-performed \(caller-observation-required\)/,
);
assert.equal(
  ActionReceiptSchema.safeParse({
    ...succeeded,
    execution: {
      status: "completed",
      result: { status: "succeeded" },
      interruption: {
        kind: "cancelled",
        completionEvidence: "post-interruption-observation",
      },
    },
  }).success,
  false,
  "a cancelled action cannot claim completion from pre-cancellation evidence",
);

const observedAfterTimeout = buildActionReceipt({
  ...succeeded,
  execution: {
    status: "completed",
    result: { status: "succeeded" },
    interruption: {
      kind: "timed-out",
      completionEvidence: "post-interruption-observation",
    },
  },
  verification: {
    status: "succeeded",
    basis: "post-interruption",
    observedAt: "2026-07-18T18:00:02.000Z",
  },
});
assert.equal(observedAfterTimeout.execution.status, "completed");
assert.equal(
  ActionReceiptSchema.safeParse({
    ...observedAfterTimeout,
    execution: {
      ...observedAfterTimeout.execution,
      result: { status: "failed", reason: "action-error" },
    },
  }).success,
  false,
  "post-interruption completion evidence cannot prove a failed action",
);

const ambiguousTransport = buildActionReceipt({
  ...succeeded,
  execution: {
    status: "unknown",
    reason: "transport-failure",
    next: "observe",
  },
  verification: { status: "not-performed", reason: "interrupted" },
  cleanup: { status: "not-performed", reason: "process-lost" },
});
assert.match(formatActionReceipt(ambiguousTransport), /observe before retry/);

console.log("action receipt verification passed");
