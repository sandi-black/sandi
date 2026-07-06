import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app } from "electron";

import { isMissingFileError } from "./fs-errors";
import { z } from "zod/v4";

// Small persisted app state: where the pet sits, which outfit she wears, and
// the behavior toggles. Lives in Electron's per-user data dir, deliberately
// separate from the credentials file the CLI shares. Loaded once at startup;
// saves are atomic (temp then rename) so a crash never tears the file.

const SettingsSchema = z.object({
  petPosition: z
    .object({ x: z.number().int(), y: z.number().int() })
    .optional(),
  outfit: z.enum(["classic", "alternate"]).default("classic"),
  wander: z.boolean().default(false),
  autoLaunch: z.boolean().default(false),
  showThinking: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

export type SettingsStore = {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
};

export function createSettingsStore(
  filePath = join(app.getPath("userData"), "settings.json"),
): SettingsStore {
  let settings = load(filePath);
  return {
    get() {
      return settings;
    },
    update(patch) {
      settings = { ...settings, ...patch };
      save(filePath, settings);
      return settings;
    },
  };
}

function load(filePath: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    // First run has no settings file; that is the defaults. A permission or
    // I/O error is a real startup failure and propagates (main's catch shows
    // it), rather than silently running on defaults and clobbering the file
    // on the next save.
    if (isMissingFileError(error)) return SettingsSchema.parse({});
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return quarantine(filePath);
  }
  const parsed = SettingsSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  return quarantine(filePath);
}

// A settings file that exists but does not parse is corrupt state, not
// first-run state. Move the original aside so the next save cannot silently
// overwrite the only copy, surface the reset, and run on defaults; a settings
// loss should not brick the whole app.
function quarantine(filePath: string): Settings {
  const backupPath = `${filePath}.corrupt`;
  renameSync(filePath, backupPath);
  console.error(
    `settings file was corrupt; moved it to ${backupPath} and reset to defaults`,
  );
  return SettingsSchema.parse({});
}

function save(filePath: string, settings: Settings): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, filePath);
}
