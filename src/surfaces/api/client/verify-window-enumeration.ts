import { assert, assertEqual } from "@/lib/verification/harness";
import { readWindowEnumeration } from "@/surfaces/api/client/desktop-state";

const WINDOW = {
  handle: "42",
  title: "Compiler notes - Grace Hopper",
  processName: "notepad",
  pid: 1906,
  minimized: false,
  bounds: { x: 10, y: 20, width: 800, height: 600 },
};

export function verifyWindowEnumerationBoundary(): void {
  const complete = readWindowEnumeration({
    stdout: line({ kind: "window", window: WINDOW }),
    stderr: "",
    code: 0,
  });
  assertEqual(complete.complete, true, "a clean enumeration is complete");
  assertEqual(complete.windows.length, 1, "a clean enumeration keeps its row");

  const partial = readWindowEnumeration({
    stdout: [
      line({ kind: "window", window: WINDOW }),
      line({
        kind: "warning",
        warning: {
          handle: "43",
          operation: "GetWindowText",
          message: "window disappeared or became inaccessible",
        },
      }),
      line({
        kind: "warning",
        warning: {
          handle: "44",
          operation: "GetWindowRect",
          message: "window disappeared or became inaccessible",
        },
      }),
    ].join("\n"),
    stderr: "",
    code: 0,
  });
  assertEqual(
    partial.complete,
    false,
    "discarded windows mark the result partial",
  );
  assertEqual(
    partial.windows.length,
    1,
    "partial enumeration keeps usable rows",
  );
  assertEqual(partial.warnings.length, 2, "each discarded row is explained");
  assert(
    partial.warnings.every((warning) => warning.handle !== undefined),
    "per-window warnings identify the failed handle",
  );

  assertThrows(
    () =>
      readWindowEnumeration({
        stdout: "",
        stderr: "EnumWindows failed",
        code: 1,
      }),
    "EnumWindows failed",
    "a top-level enumeration failure still fails closed",
  );
  assertThrows(
    () =>
      readWindowEnumeration({
        stdout: line({ kind: "window", window: { ...WINDOW, pid: -1 } }),
        stderr: "",
        code: 0,
      }),
    "unexpected record shape",
    "malformed subprocess output fails at the boundary",
  );
  console.log(
    "ok window enumeration distinguishes complete, partial, and failed results",
  );
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

function assertThrows(
  action: () => unknown,
  expected: string,
  message: string,
): void {
  let actual = "";
  try {
    action();
  } catch (error) {
    actual = error instanceof Error ? error.message : String(error);
  }
  assert(actual.includes(expected), `${message}: ${actual}`);
}
