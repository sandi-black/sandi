import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod/v4";
import { projectDirs } from "@/lib/config/platform-dirs";

// A per-device bearer token is the api surface's hex secret: 32 bytes rendered
// as 64 lowercase hex chars. Pinning the exact shape here means a truncated or
// mangled token in the on-disk file is rejected at load, not as a late 401.
const HEX_TOKEN = /^[0-9a-f]{64}$/;

// The server url must be an absolute http(s) origin: the client builds request
// URLs against it, so a relative or non-http value could never carry a turn.
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

// The single parser for a server url, shared by the credentials schema and the
// CLI so a `--url` flag or `SANDI_API_URL` value is validated at its entry point
// rather than stored raw and failing on the first request.
export const ServerUrlSchema = z
  .string()
  .refine(isHttpUrl, "must be an http(s) url");

// Credentials the desktop client holds after pairing. This file lives on the
// human's own machine and is NOT Sandi-managed server state, so it is written
// with plain fs (owner-only mode), never the managed-write lock. The bearer
// token authenticates both the turn requests and the device link.
export const DesktopCredentialsSchema = z.object({
  url: ServerUrlSchema,
  token: z.string().regex(HEX_TOKEN, "must be a 64-character hex token"),
  deviceId: z.string().min(1),
  identityId: z.string().min(1),
});
export type DesktopCredentials = z.infer<typeof DesktopCredentialsSchema>;

export type ParseLoginResult =
  | { ok: true; credentials: DesktopCredentials }
  | { ok: false; field: string; message: string };

// Validates a `login` command's raw inputs into stored credentials in one pass.
// The url and token are checked by DesktopCredentialsSchema (the same boundary
// the file is read back through), so they are parsed once here rather than
// pre-validated and then revalidated by the schema. On failure it reports which
// field was at fault so the CLI can print a precise message.
export function parseLoginCredentials(input: {
  url: string;
  token: string;
  identityId: string;
  deviceId: string;
}): ParseLoginResult {
  const parsed = DesktopCredentialsSchema.safeParse(input);
  if (parsed.success) return { ok: true, credentials: parsed.data };
  const issue = parsed.error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : "input";
  return { ok: false, field, message: issue?.message ?? "invalid credentials" };
}

export function desktopConfigPath(): string {
  const explicit = process.env["SANDI_DESKTOP_CONFIG"]?.trim();
  if (explicit) return resolve(expandHome(explicit));
  return join(projectDirs("sandi").configDir, "desktop.json");
}

// Where the credentials file lived before it moved to the OS config dir. Kept so
// an existing install is migrated forward (see migrateLegacyDesktopConfig)
// rather than silently appearing unpaired.
export function legacyDesktopConfigPath(): string {
  return join(homedir(), ".sandi", "desktop.json");
}

// Moves a pre-existing ~/.sandi/desktop.json to the OS config dir the first time
// the client runs after the move, then returns the new path; returns undefined
// when there is nothing to migrate. A no-op when SANDI_DESKTOP_CONFIG pins the
// location explicitly (the operator owns the path then), when the destination
// already exists, or when no legacy file is present. The rename preserves the
// file's owner-only mode, so the token is never copied through a wider one. The
// paths are injectable so the move can be tested against temp dirs rather than
// the real home directory.
export async function migrateLegacyDesktopConfig(
  paths: { legacy?: string; target?: string } = {},
): Promise<string | undefined> {
  if (!paths.target && process.env["SANDI_DESKTOP_CONFIG"]?.trim()) {
    return undefined;
  }
  const target = paths.target ?? desktopConfigPath();
  if (await pathExists(target)) return undefined;
  const legacy = paths.legacy ?? legacyDesktopConfigPath();
  if (!(await pathExists(legacy))) return undefined;
  await mkdir(dirname(target), { recursive: true });
  await rename(legacy, target);
  return target;
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

// True when the path exists, false only when it is genuinely absent. A
// permission or other filesystem error is rethrown rather than read as "absent",
// so the migration surfaces a real failure instead of silently skipping.
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
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
