import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// A small analogue of Rust's `directories` crate: resolves the per-OS base
// directories an application should use for its config, data, and cache,
// following each platform's convention. Vendored rather than pulled in as a
// dependency to keep the install lean (no node_modules surface for one path
// helper) and the behavior auditable in one file.
//
// The mapping, for app name `sandi`:
//
//   Windows  config %APPDATA%\sandi          data %LOCALAPPDATA%\sandi\data   cache %LOCALAPPDATA%\sandi\cache
//   macOS    ~/Library/Application Support/sandi (config and data)            ~/Library/Caches/sandi
//   Linux    $XDG_CONFIG_HOME|~/.config/sandi  $XDG_DATA_HOME|~/.local/share/sandi  $XDG_CACHE_HOME|~/.cache/sandi
//
// On macOS config and data resolve to the same directory, which is the platform
// convention (the `directories` crate does the same); callers that need both
// separated should not rely on them differing there.

export type ProjectDirs = {
  configDir: string;
  dataDir: string;
  cacheDir: string;
};

// The pieces of the environment that decide the paths, passed in so the resolver
// is a pure function the tests can drive for every platform without touching the
// real process.
export type DirContext = {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
};

export function projectDirs(app: string): ProjectDirs {
  return resolveProjectDirs(app, {
    platform: process.platform,
    home: homedir(),
    env: process.env,
  });
}

export function resolveProjectDirs(app: string, ctx: DirContext): ProjectDirs {
  // Join with the target platform's separator (not the host's), so the resolver
  // yields correct paths under test on any OS. In production the target is the
  // host, so this is the platform's own join either way.
  const join = ctx.platform === "win32" ? win32.join : posix.join;
  if (ctx.platform === "win32") {
    // Only an absolute base from the environment is trusted. A relative or
    // drive-relative APPDATA/LOCALAPPDATA would otherwise be joined into the
    // config path and resolve against the caller's cwd, writing the token
    // somewhere unintended; fall back to the home subpath instead.
    const roaming =
      absoluteWindows(ctx.env["APPDATA"]) ??
      join(ctx.home, "AppData", "Roaming");
    const local =
      absoluteWindows(ctx.env["LOCALAPPDATA"]) ??
      join(ctx.home, "AppData", "Local");
    return {
      configDir: join(roaming, app),
      dataDir: join(local, app, "data"),
      cacheDir: join(local, app, "cache"),
    };
  }
  if (ctx.platform === "darwin") {
    const support = join(ctx.home, "Library", "Application Support", app);
    return {
      configDir: support,
      dataDir: support,
      cacheDir: join(ctx.home, "Library", "Caches", app),
    };
  }
  // Linux and other unix-likes follow the XDG Base Directory spec, honoring the
  // env overrides and falling back to the spec's documented defaults.
  return {
    configDir: join(xdgBase(ctx, join, "XDG_CONFIG_HOME", [".config"]), app),
    dataDir: join(
      xdgBase(ctx, join, "XDG_DATA_HOME", [".local", "share"]),
      app,
    ),
    cacheDir: join(xdgBase(ctx, join, "XDG_CACHE_HOME", [".cache"]), app),
  };
}

// XDG only honors an absolute path in the override; a relative value is ignored
// in favor of the default, per the spec.
function xdgBase(
  ctx: DirContext,
  join: (...parts: string[]) => string,
  variable: string,
  fallback: readonly string[],
): string {
  const override = trimmed(ctx.env[variable]);
  if (override && posix.isAbsolute(override)) return override;
  return join(ctx.home, ...fallback);
}

// A trimmed, absolute Windows base path, or undefined when the value is empty or
// not absolute (a relative or drive-relative path is rejected).
function absoluteWindows(value: string | undefined): string | undefined {
  const next = trimmed(value);
  return next && win32.isAbsolute(next) ? next : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
