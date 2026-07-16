import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isMissingFileError } from "../fs-errors";
import { z } from "zod/v4";

export const TURN_SIGNAL_FILE_ENV = "SANDI_TURN_SIGNAL_FILE";

const TurnSignalSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export type TurnSignal = z.infer<typeof TurnSignalSchema>;

export async function recordTurnSignal(signal: TurnSignal): Promise<void> {
  const path = process.env[TURN_SIGNAL_FILE_ENV]?.trim();
  if (!path) throw new Error("Turn signal file is not configured");
  const parsed = TurnSignalSchema.parse(signal);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
}

export async function readTurnSignals(path: string): Promise<TurnSignal[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => TurnSignalSchema.parse(JSON.parse(line)));
}
