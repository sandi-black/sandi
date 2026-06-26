import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod/v4";

// Credentials the desktop client holds after pairing. This file lives on the
// human's own machine and is NOT Sandi-managed server state, so it is written
// with plain fs (owner-only mode), never the managed-write lock. The bearer
// token authenticates both the turn requests and the device link.
const DesktopCredentialsSchema = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  deviceId: z.string().min(1),
  identityId: z.string().min(1),
});
export type DesktopCredentials = z.infer<typeof DesktopCredentialsSchema>;

export function desktopConfigPath(): string {
  const explicit = process.env["SANDI_DESKTOP_CONFIG"]?.trim();
  if (explicit) return resolve(explicit);
  return join(homedir(), ".sandi", "desktop.json");
}

export async function loadDesktopCredentials(
  path: string,
): Promise<DesktopCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  return DesktopCredentialsSchema.parse(JSON.parse(raw));
}

export async function saveDesktopCredentials(
  path: string,
  credentials: DesktopCredentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFile only applies the mode when it creates the file; chmod an existing
  // one too so a re-pair never widens the permissions. Best effort: platforms
  // that ignore POSIX modes (Windows) simply no-op.
  try {
    await chmod(path, 0o600);
  } catch {
    // Ignore: the filesystem does not enforce POSIX permissions here.
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
