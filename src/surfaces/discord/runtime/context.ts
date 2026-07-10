import { join, resolve } from "node:path";

import {
  readPlatformContext,
  type SandiSurfaceContext,
  UNIFIED_RUNTIME_ENTRY,
} from "../../../lib/surface-context";
import type { ReminderUser } from "../reminders/schemas";
import { type DiscordContext, DiscordContextSchema } from "../shared/rest";

export const DISCORD_RUNTIME_IMPORT = "./sandi/runtime.ts";
// Every surface composes the unified runtime, so a Discord turn can also reach
// GitHub and the desktop helpers, not only Discord's own.
export const DISCORD_RUNTIME_ENTRY = UNIFIED_RUNTIME_ENTRY;

export const DISCORD_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "discord",
  skillsSurface: "discord",
  runtimeImport: DISCORD_RUNTIME_IMPORT,
  runtimeEntry: DISCORD_RUNTIME_ENTRY,
  attachmentsRoot: discordAttachmentsRoot(),
};

// Predates the unified SANDI_PLATFORM_CONTEXT env var; still honored as a
// fallback so an older host process launching the Discord surface keeps
// working.
const DISCORD_LEGACY_CONTEXT_ENV = "SANDI_DISCORD_CONTEXT";

export function readDiscordPlatformContext(): DiscordContext | undefined {
  return readPlatformContext("discord", DiscordContextSchema, {
    legacyEnvVar: DISCORD_LEGACY_CONTEXT_ENV,
  });
}

function discordAttachmentsRoot(): string {
  return resolve(
    process.env["SANDI_SURFACE_ATTACHMENTS_ROOT"]?.trim() ||
      process.env["SANDI_DISCORD_ATTACHMENTS_ROOT"]?.trim() ||
      join(
        process.env["SANDI_DATA_DIR"]?.trim() || "data",
        "discord-attachments",
      ),
  );
}

// The reminder-attributed human behind the current Discord turn, read from
// the platform context's author block. Shared by the todo and reminders
// runtime helpers, both of which need this to stamp a created/updated-by
// identity when the turn does not pass one explicitly.
export function currentDiscordReminderUser(): ReminderUser | undefined {
  return readDiscordPlatformContext()?.author;
}
