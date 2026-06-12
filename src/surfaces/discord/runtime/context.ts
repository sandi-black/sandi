import { join, resolve } from "node:path";

import type { SandiSurfaceContext } from "@/lib/surface-context";

export const DISCORD_RUNTIME_IMPORT = "./sandi/runtime.ts";
export const DISCORD_RUNTIME_ENTRY = "./src/surfaces/discord/runtime/index.ts";

export const DISCORD_SURFACE_CONTEXT: SandiSurfaceContext = {
  name: "discord",
  skillsSurface: "discord",
  runtimeImport: DISCORD_RUNTIME_IMPORT,
  runtimeEntry: DISCORD_RUNTIME_ENTRY,
  attachmentsRoot: discordAttachmentsRoot(),
};

export function readDiscordPlatformContext(): string | undefined {
  const raw = process.env["SANDI_PLATFORM_CONTEXT"]?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "platform" in parsed &&
        parsed.platform === "discord"
      ) {
        return raw;
      }
    } catch {
      return undefined;
    }
  }
  return process.env["SANDI_DISCORD_CONTEXT"]?.trim();
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
