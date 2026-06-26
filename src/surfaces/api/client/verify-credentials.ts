import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  desktopConfigPath,
  loadDesktopCredentials,
  saveDesktopCredentials,
} from "@/surfaces/api/client/credentials";

// The desktop credentials file holds a bearer token, so it must be written
// owner-only and round-trip intact, and the documented ~ config override must
// resolve to the home directory rather than a literal ./~ path.

async function verifyCredentials(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sandi-credentials-"));
  try {
    const path = join(dir, "nested", "desktop.json");
    const credentials = {
      url: "http://127.0.0.1:8787",
      token: "secret-token",
      deviceId: "device-1",
      identityId: "tester",
    };
    await saveDesktopCredentials(path, credentials);
    const loaded = await loadDesktopCredentials(path);
    assert(loaded !== undefined, "saved credentials load back");
    assert(loaded?.token === "secret-token", "the token round-trips");
    console.log("ok credentials save and load round-trip");

    // Re-saving over an existing file must keep it owner-only, the case the
    // atomic temp-and-rename guards (an in-place overwrite would not retighten).
    await saveDesktopCredentials(path, { ...credentials, token: "rotated" });
    const rotated = await loadDesktopCredentials(path);
    assert(rotated?.token === "rotated", "a re-save replaces the token");
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("credentials verification passed");
}

function assert(condition: unknown, label: string): asserts condition {
  if (condition) return;
  console.error(`assertion failed: ${label}`);
  process.exit(1);
}

await verifyCredentials();
