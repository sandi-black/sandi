import { z } from "zod/v4";

export const ACTION_RECEIPT_VERSION = 1;
export const ACTION_RECEIPT_STDOUT_PREFIX = "SANDI_ACTION_RECEIPT:";
export const MAX_ACTION_RECEIPT_JSON_CHARS = 8_192;
export const MAX_NATIVE_CONTROL_PATH_CHARS = 2_048;

const ActionTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const TargetSchema = z
  .object({
    pid: z.number().int().positive().max(4_294_967_295),
    hwnd: z.string().regex(/^[1-9][0-9]{0,19}$/),
    control: z
      .object({
        kind: z.literal("uia-path"),
        path: z
          .string()
          .regex(/^[0-9]+(?:\/[0-9]+)*$/)
          .max(MAX_NATIVE_CONTROL_PATH_CHARS),
      })
      .strict()
      .optional(),
  })
  .strict();

const ObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("fresh"),
      observedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      observedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

const CompletedExecutionSchema = z
  .object({
    status: z.literal("completed"),
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("succeeded") }).strict(),
      z
        .object({
          status: z.literal("failed"),
          reason: z.enum([
            "action-error",
            "verification-failed",
            "cleanup-failed",
          ]),
        })
        .strict(),
    ]),
    interruption: z
      .object({
        kind: z.enum(["cancelled", "timed-out"]),
        completionEvidence: z.literal("post-interruption-observation"),
      })
      .strict()
      .optional(),
  })
  .strict();

const ExecutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not-started"),
      reason: z.enum([
        "refused",
        "ambiguous-target",
        "stale-target",
        "unsupported",
      ]),
    })
    .strict(),
  CompletedExecutionSchema,
  z
    .object({
      status: z.literal("partial"),
      reason: z.enum(["action-error", "cancelled", "timed-out"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["cancelled", "timed-out", "transport-failure"]),
      next: z.literal("observe"),
    })
    .strict(),
]);

const VerificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      basis: z.enum(["post-action", "post-interruption"]),
      observedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["target-missing", "state-mismatch", "observation-error"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("not-performed"),
      reason: z.enum([
        "not-started",
        "interrupted",
        "unavailable",
        "caller-observation-required",
      ]),
    })
    .strict(),
]);

const CleanupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["clipboard-restore", "input-release", "process-cleanup"]),
    })
    .strict(),
  z.object({ status: z.literal("not-required") }).strict(),
  z
    .object({
      status: z.literal("not-performed"),
      reason: z.enum(["not-started", "process-lost"]),
    })
    .strict(),
]);

export const ActionReceiptSchema = z
  .object({
    version: z.literal(ACTION_RECEIPT_VERSION),
    action: ActionTokenSchema,
    method: ActionTokenSchema,
    target: TargetSchema,
    observation: ObservationSchema,
    execution: ExecutionSchema,
    verification: VerificationSchema,
    cleanup: CleanupSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.execution.status === "completed" &&
      receipt.execution.interruption !== undefined &&
      receipt.execution.result.status !== "succeeded"
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution", "result"],
        message:
          "post-interruption completion evidence proves a succeeded action",
      });
    }
    if (
      receipt.execution.status === "completed" &&
      receipt.execution.interruption !== undefined &&
      (receipt.verification.status !== "succeeded" ||
        receipt.verification.basis !== "post-interruption")
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message:
          "completion after cancellation or timeout requires post-interruption observation",
      });
    }
    if (
      receipt.execution.status === "unknown" &&
      receipt.verification.status !== "not-performed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message:
          "an unknown action must be observed before its outcome changes",
      });
    }
    if (
      receipt.execution.status === "completed" &&
      receipt.observation.status !== "fresh"
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "a completed action requires a fresh retained target",
      });
    }
  });

export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;
export type ActionReceiptInput = Omit<ActionReceipt, "version">;

export function buildActionReceipt(input: ActionReceiptInput): ActionReceipt {
  return ActionReceiptSchema.parse({
    version: ACTION_RECEIPT_VERSION,
    ...input,
  });
}

export function parseActionReceipt(input: unknown): ActionReceipt {
  return ActionReceiptSchema.parse(input);
}

export type ActionReceiptExtraction =
  | { status: "absent"; stdout: string }
  | { status: "parsed"; stdout: string; receipt: ActionReceipt }
  | { status: "invalid"; stdout: string; error: string };

export function extractActionReceipt(stdout: string): ActionReceiptExtraction {
  const lines = stdout.split(/\r?\n/);
  const receiptLines = lines.filter((line) =>
    line.startsWith(ACTION_RECEIPT_STDOUT_PREFIX),
  );
  const cleanStdout = lines
    .filter((line) => !line.startsWith(ACTION_RECEIPT_STDOUT_PREFIX))
    .join("\n")
    .trimEnd();
  if (receiptLines.length === 0) {
    return { status: "absent", stdout };
  }
  if (receiptLines.length !== 1) {
    return {
      status: "invalid",
      stdout: cleanStdout,
      error: "AutoIt emitted more than one action receipt",
    };
  }
  const receiptLine = receiptLines[0];
  if (receiptLine === undefined) {
    return {
      status: "invalid",
      stdout: cleanStdout,
      error: "AutoIt action receipt was unavailable",
    };
  }
  if (
    receiptLine.length - ACTION_RECEIPT_STDOUT_PREFIX.length >
    MAX_ACTION_RECEIPT_JSON_CHARS
  ) {
    return {
      status: "invalid",
      stdout: cleanStdout,
      error: "AutoIt action receipt exceeds 8192 characters",
    };
  }
  try {
    const raw: unknown = JSON.parse(
      receiptLine.slice(ACTION_RECEIPT_STDOUT_PREFIX.length),
    );
    const parsed = ActionReceiptSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "invalid",
        stdout: cleanStdout,
        error: "AutoIt emitted an invalid action receipt",
      };
    }
    return { status: "parsed", stdout: cleanStdout, receipt: parsed.data };
  } catch {
    return {
      status: "invalid",
      stdout: cleanStdout,
      error: "AutoIt emitted malformed action receipt JSON",
    };
  }
}

export function formatActionReceipt(receipt: ActionReceipt): string {
  const control = receipt.target.control
    ? ` control ${receipt.target.control.path}`
    : "";
  const execution = executionSummary(receipt.execution);
  return [
    `${receipt.action} via ${receipt.method} on pid ${receipt.target.pid} hwnd ${receipt.target.hwnd}${control}: ${execution}`,
    verificationSummary(receipt.verification),
    cleanupSummary(receipt.cleanup),
  ].join("; ");
}

function executionSummary(execution: ActionReceipt["execution"]): string {
  switch (execution.status) {
    case "not-started":
      return `not started (${execution.reason})`;
    case "completed":
      return execution.result.status === "succeeded"
        ? "execution succeeded"
        : `execution failed (${execution.result.reason})`;
    case "partial":
      return `partial (${execution.reason})`;
    case "unknown":
      return `unknown (${execution.reason}; observe before retry)`;
  }
}

function verificationSummary(
  verification: ActionReceipt["verification"],
): string {
  return verification.status === "succeeded"
    ? `verification succeeded (${verification.basis})`
    : `verification ${verification.status} (${verification.reason})`;
}

function cleanupSummary(cleanup: ActionReceipt["cleanup"]): string {
  return cleanup.status === "failed" || cleanup.status === "not-performed"
    ? `cleanup ${cleanup.status} (${cleanup.reason})`
    : `cleanup ${cleanup.status}`;
}
