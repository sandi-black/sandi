import {
  type DirContext,
  resolveProjectDirs,
} from "@/lib/config/platform-dirs";

// resolveProjectDirs is a pure function of the platform, the home directory, and
// the environment, so the per-OS conventions can be checked without running on
// each OS or mutating the real process.

function verifyPlatformDirs(): void {
  verifyWindows();
  verifyWindowsFallback();
  verifyMacos();
  verifyLinuxXdg();
  verifyLinuxDefaults();
  console.log("platform dirs verification passed");
}

function verifyWindows(): void {
  const dirs = resolveProjectDirs("sandi", {
    platform: "win32",
    home: "C:\\Users\\me",
    env: {
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    },
  });
  assertEqual(
    dirs.configDir,
    "C:\\Users\\me\\AppData\\Roaming\\sandi",
    "windows config is under %APPDATA%",
  );
  assertEqual(
    dirs.dataDir,
    "C:\\Users\\me\\AppData\\Local\\sandi\\data",
    "windows data is under %LOCALAPPDATA%",
  );
  assertEqual(
    dirs.cacheDir,
    "C:\\Users\\me\\AppData\\Local\\sandi\\cache",
    "windows cache is under %LOCALAPPDATA%",
  );
  console.log(
    "ok windows uses Roaming for config and Local for data and cache",
  );
}

function verifyWindowsFallback(): void {
  // With the AppData env vars unset, fall back to the well-known subpaths of the
  // home directory rather than producing a bare or cwd-relative path.
  const unset = resolveProjectDirs("sandi", {
    platform: "win32",
    home: "C:\\Users\\me",
    env: {},
  });
  assertEqual(
    unset.configDir,
    "C:\\Users\\me\\AppData\\Roaming\\sandi",
    "windows config falls back to ~/AppData/Roaming",
  );

  // A relative or drive-relative override is not absolute, so it is ignored in
  // favor of the home subpath rather than resolved against the cwd.
  const relative = resolveProjectDirs("sandi", {
    platform: "win32",
    home: "C:\\Users\\me",
    env: { APPDATA: "Roaming", LOCALAPPDATA: "C:relative" },
  });
  assertEqual(
    relative.configDir,
    "C:\\Users\\me\\AppData\\Roaming\\sandi",
    "windows config ignores a relative APPDATA",
  );
  assertEqual(
    relative.dataDir,
    "C:\\Users\\me\\AppData\\Local\\sandi\\data",
    "windows data ignores a drive-relative LOCALAPPDATA",
  );
  console.log("ok windows falls back when the env override is not absolute");
}

function verifyMacos(): void {
  const dirs = resolveProjectDirs("sandi", {
    platform: "darwin",
    home: "/Users/me",
    env: {},
  });
  assertEqual(
    dirs.configDir,
    "/Users/me/Library/Application Support/sandi",
    "macos config is under Application Support",
  );
  assertEqual(
    dirs.dataDir,
    "/Users/me/Library/Application Support/sandi",
    "macos data shares Application Support with config",
  );
  assertEqual(
    dirs.cacheDir,
    "/Users/me/Library/Caches/sandi",
    "macos cache is under Library/Caches",
  );
  console.log("ok macos uses Application Support and Library/Caches");
}

function verifyLinuxXdg(): void {
  const dirs = resolveProjectDirs("sandi", {
    platform: "linux",
    home: "/home/me",
    env: {
      XDG_CONFIG_HOME: "/home/me/.xconfig",
      XDG_DATA_HOME: "/home/me/.xdata",
      XDG_CACHE_HOME: "/home/me/.xcache",
    },
  });
  assertEqual(
    dirs.configDir,
    "/home/me/.xconfig/sandi",
    "linux config honors XDG_CONFIG_HOME",
  );
  assertEqual(
    dirs.dataDir,
    "/home/me/.xdata/sandi",
    "linux data honors XDG_DATA_HOME",
  );
  assertEqual(
    dirs.cacheDir,
    "/home/me/.xcache/sandi",
    "linux cache honors XDG_CACHE_HOME",
  );
  console.log("ok linux honors the XDG env overrides");
}

function verifyLinuxDefaults(): void {
  // An unset or relative XDG override falls back to the spec default; the spec
  // says a relative value must be ignored.
  const ctx: DirContext = {
    platform: "linux",
    home: "/home/me",
    env: { XDG_CONFIG_HOME: "relative/path" },
  };
  const dirs = resolveProjectDirs("sandi", ctx);
  assertEqual(
    dirs.configDir,
    "/home/me/.config/sandi",
    "linux config falls back to ~/.config (ignoring a relative override)",
  );
  assertEqual(
    dirs.dataDir,
    "/home/me/.local/share/sandi",
    "linux data falls back to ~/.local/share",
  );
  assertEqual(
    dirs.cacheDir,
    "/home/me/.cache/sandi",
    "linux cache falls back to ~/.cache",
  );
  console.log("ok linux falls back to the XDG defaults");
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

verifyPlatformDirs();
