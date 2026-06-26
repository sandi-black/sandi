import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  if (explicit) return resolve(expandHome(explicit));
  return join(homedir(), ".sandi", "desktop.json");
}

// A leading ~ is not shell-expanded inside a .env value, so expand it here.
// Without this, the documented `~/.sandi/desktop.json` example would resolve
// under the current directory (./~/.sandi/...) instead of the user's home.
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
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
  const body = `${JSON.stringify(credentials, null, 2)}\n`;
  // Write a sibling temp file with owner-only mode, then rename it over the
  // target. The destination inode carries 0o600 from creation, so the token is
  // never briefly world-readable and a re-pair over an existing permissive file
  // cannot leave wider permissions behind (writeFile's mode applies only when it
  // creates a file, so overwriting in place would not retighten one). A failure
  // throws rather than reporting success with an unprotected file. On platforms
  // that ignore POSIX modes (Windows) the mode is a no-op and rename still
  // replaces atomically.
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
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
