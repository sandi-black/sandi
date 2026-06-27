import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { projectDirs } from "@/lib/config/platform-dirs";
import {
  desktopConfigPath,
  loadDesktopCredentials,
  migrateLegacyDesktopConfig,
  parseLoginCredentials,
  saveDesktopCredentials,
} from "@/surfaces/api/client/credentials";

// The desktop credentials file holds a bearer token, so it must be written
// owner-only and round-trip intact, and the documented ~ config override must
// resolve to the home directory rather than a literal ./~ path.

// 64-char hex stand-ins for the api surface's per-device token, the only shape
// the schema accepts.
const TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ROTATED_TOKEN =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

async function verifyCredentials(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sandi-credentials-"));
  try {
    const path = join(dir, "nested", "desktop.json");
    const credentials = {
      url: "http://127.0.0.1:8787",
      token: TOKEN,
      deviceId: "device-1",
      identityId: "tester",
    };
    await saveDesktopCredentials(path, credentials);
    const loaded = await loadDesktopCredentials(path);
    assert(loaded !== undefined, "saved credentials load back");
    assert(loaded?.token === TOKEN, "the token round-trips");
    console.log("ok credentials save and load round-trip");

    // Re-saving over an existing file must keep it owner-only, the case the
    // atomic temp-and-rename guards (an in-place overwrite would not retighten).
    await saveDesktopCredentials(path, {
      ...credentials,
      token: ROTATED_TOKEN,
    });
    const rotated = await loadDesktopCredentials(path);
    assert(rotated?.token === ROTATED_TOKEN, "a re-save replaces the token");
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      assert(
        mode === 0o600,
        `the token file is owner-only after a re-save (got ${mode.toString(8)})`,
      );
      console.log("ok the token file stays owner-only across re-saves");
    }

    const missing = await loadDesktopCredentials(join(dir, "absent.json"));
    assert(missing === undefined, "a missing config loads as undefined");
    console.log("ok a missing config loads as undefined");

    // A file whose token is not the expected 64-hex shape is rejected at load,
    // not stored and trusted: the schema is the boundary, so a tampered or
    // truncated token surfaces here rather than as a late 401.
    const badPath = join(dir, "bad.json");
    await writeFile(
      badPath,
      JSON.stringify({ ...credentials, token: "not-hex" }),
      "utf8",
    );
    let rejected = false;
    try {
      await loadDesktopCredentials(badPath);
    } catch {
      rejected = true;
    }
    assert(rejected, "a malformed token is rejected at load");
    console.log("ok a malformed token is rejected at load");

    // A non-http url is rejected the same way: the server origin is parsed at
    // the boundary, so a relative or non-http value never reaches a request.
    const badUrlPath = join(dir, "bad-url.json");
    await writeFile(
      badUrlPath,
      JSON.stringify({ ...credentials, url: "ftp://example.com" }),
      "utf8",
    );
    let urlRejected = false;
    try {
      await loadDesktopCredentials(badUrlPath);
    } catch {
      urlRejected = true;
    }
    assert(urlRejected, "a non-http url is rejected at load");
    console.log("ok a non-http url is rejected at load");

    const previous = process.env["SANDI_DESKTOP_CONFIG"];
    process.env["SANDI_DESKTOP_CONFIG"] = "~/.sandi/desktop.json";
    try {
      const resolved = desktopConfigPath();
      assert(
        resolved === join(homedir(), ".sandi", "desktop.json"),
        `a leading ~ expands to home (got ${resolved})`,
      );
      console.log("ok a leading ~ in the config path expands to home");
    } finally {
      if (previous === undefined) delete process.env["SANDI_DESKTOP_CONFIG"];
      else process.env["SANDI_DESKTOP_CONFIG"] = previous;
    }

    // With no override, the credentials file lands in the OS config dir rather
    // than the old ~/.sandi location.
    const saved = process.env["SANDI_DESKTOP_CONFIG"];
    delete process.env["SANDI_DESKTOP_CONFIG"];
    try {
      const expected = join(projectDirs("sandi").configDir, "desktop.json");
      const resolved = desktopConfigPath();
      assert(
        resolved === expected,
        `the default config path is the OS config dir (got ${resolved})`,
      );
      console.log("ok the default config path is the OS config dir");
    } finally {
      if (saved !== undefined) process.env["SANDI_DESKTOP_CONFIG"] = saved;
    }

    verifyLoginParse();
    await verifyLegacyMigration(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("credentials verification passed");
}

// The login command validates its raw inputs in one pass; a good payload yields
// credentials, and a bad token or url is rejected with the offending field named
// so the CLI can print a precise message.
function verifyLoginParse(): void {
  const good = parseLoginCredentials({
    url: "http://127.0.0.1:8787",
    token: TOKEN,
    identityId: "self",
    deviceId: "box",
  });
  assert(
    good.ok && good.credentials.token === TOKEN,
    "a valid login payload parses into credentials",
  );

  const badToken = parseLoginCredentials({
    url: "http://127.0.0.1:8787",
    token: "not-hex",
    identityId: "self",
    deviceId: "box",
  });
  assert(
    !badToken.ok && badToken.field === "token",
    "a malformed token is rejected on the token field",
  );

  const badUrl = parseLoginCredentials({
    url: "ftp://example.com",
    token: TOKEN,
    identityId: "self",
    deviceId: "box",
  });
  assert(
    !badUrl.ok && badUrl.field === "url",
    "a non-http url is rejected on the url field",
  );
  console.log("ok parseLoginCredentials validates the login payload once");
}

// A user paired before the file moved has a ~/.sandi/desktop.json; the first run
// after the move carries it forward to the OS config dir, intact and owner-only,
// and a second run is a no-op.
async function verifyLegacyMigration(dir: string): Promise<void> {
  const legacy = join(dir, "home", ".sandi", "desktop.json");
  const target = join(dir, "config", "sandi", "desktop.json");
  const credentials = {
    url: "http://127.0.0.1:8787",
    token: TOKEN,
    deviceId: "device-1",
    identityId: "tester",
  };
  await saveDesktopCredentials(legacy, credentials);

  const moved = await migrateLegacyDesktopConfig({ legacy, target });
  assert(moved === target, "the legacy config is moved to the target path");
  const loaded = await loadDesktopCredentials(target);
  assert(loaded?.token === TOKEN, "the migrated config loads intact");
  const gone = await loadDesktopCredentials(legacy);
  assert(gone === undefined, "the legacy file no longer exists after the move");
  if (process.platform !== "win32") {
    const mode = (await stat(target)).mode & 0o777;
    assert(
      mode === 0o600,
      `the migrated token file stays owner-only (got ${mode.toString(8)})`,
    );
  }

  const again = await migrateLegacyDesktopConfig({ legacy, target });
  assert(again === undefined, "a second migration is a no-op");
  console.log("ok a legacy ~/.sandi config migrates once to the OS config dir");
}

function assert(condition: unknown, label: string): asserts condition {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

await verifyCredentials();
