import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  readTurnSignals,
  recordTurnSignal,
  TURN_SIGNAL_FILE_ENV,
} from "@/lib/provider/turn-signals";
import { withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-turn-signals-", async (dir) => {
  const path = join(dir, "signals.jsonl");
  const previous = process.env[TURN_SIGNAL_FILE_ENV];
  try {
    process.env[TURN_SIGNAL_FILE_ENV] = path;
    await recordTurnSignal({ kind: "test:route", value: "alpha" });
    await recordTurnSignal({ kind: "test:route", value: "beta" });
    assert.deepEqual(await readTurnSignals(path), [
      { kind: "test:route", value: "alpha" },
      { kind: "test:route", value: "beta" },
    ]);

    await writeFile(path, '{"kind":"test:route"}\n', "utf8");
    await assert.rejects(readTurnSignals(path));

    delete process.env[TURN_SIGNAL_FILE_ENV];
    await assert.rejects(
      recordTurnSignal({ kind: "test:route", value: "alpha" }),
      /not configured/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env[TURN_SIGNAL_FILE_ENV];
    } else {
      process.env[TURN_SIGNAL_FILE_ENV] = previous;
    }
  }
});

console.log("Provider turn signal verification passed");
