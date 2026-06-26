#!/usr/bin/env node
//
// .claude/bootstrap.mjs: the per-session half of the Claude Code environment
// setup for Sandi.
//
// WHAT THIS IS
//   The cheap, runs-every-time half of bootstrapping a session. It is wired as
//   a SessionStart hook in .claude/settings.json and runs on every session
//   start and resume, BOTH locally and in Claude Code on the web, on macOS,
//   Linux, and Windows. The other half (cloud-setup.sh, the cloud "Setup
//   script") does the cloud-only, root/apt toolchain install before Claude Code
//   launches; this does the fast, cross-platform per-session work.
//
//   Node specifically: Claude Code itself runs on Node, so `node` is guaranteed
//   present on every platform with no extra toolchain and no compile step. This
//   file stays Node + standard library only: no dependencies, no build.
//
// STEP GATING
//   There is no blanket "cloud only" guard. Each step decides for itself
//   whether it applies, so the same file is correct everywhere:
//     - writeEnvVars() runs only in the cloud (needs $CLAUDE_ENV_FILE).
//     - installDeps()  runs only for the package managers the repo uses.
//   The script never fails a session: steps log and continue on error.
//
// WHY NO `docker compose up` STEP
//   The cross-platform template ships a compose step, but Sandi's compose.yaml
//   is the PRODUCTION bot image (build context ., the long-running Discord
//   surface), not a stack of dev service dependencies. Sandi keeps all runtime
//   state in files under data/; there is no database or cache service to bring
//   up for a dev session. Running `docker compose up` here would build the image
//   and start the bot, which needs real secrets (DISCORD_BOT_TOKEN, an
//   authenticated `pi`, etc.) and would hang on `--wait`. The dev loop is
//   `npm run dev` / `npm run check`, so we intentionally omit the compose step.

import { existsSync, appendFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this file's own location (<root>/.claude/bootstrap.mjs)
// rather than from process.cwd(). SessionStart hooks are invoked from the
// session's working directory, which is normally the repo root but is not
// guaranteed to be. Anchoring on import.meta.url makes every file operation
// below correct regardless of cwd.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const isCloud = process.env.CLAUDE_CODE_REMOTE === "true";
const log = (msg) => console.log(`[bootstrap] ${msg}`);

// --- Step 1: env vars (cloud only) -----------------------------------------
// Cloud sessions persist env vars for later Bash tool calls by appending
// `export` lines to the file named by $CLAUDE_ENV_FILE. Locally there is no
// such file, so this step self-gates off.
//
// Sandi needs nothing here for the dev loop: the `npm run check` gate and the
// verify scripts read their own defaults, and every value the bot actually
// needs at runtime (Discord/Pi/API tokens, the Google Maps key) is a SECRET
// that must NOT live in versioned config or the shared env-vars UI field.
// Provide secrets out of band and have the code read them from the environment.
// If a genuinely non-secret default is ever needed, add it to `vars` below.
function writeEnvVars() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!isCloud || !envFile) {
    log("env vars: not a cloud session (no $CLAUDE_ENV_FILE); skipping.");
    return;
  }
  const vars = {
    // NON-SECRET dev defaults only. Example:
    // SANDI_API_HOST: "127.0.0.1",
  };
  const entries = Object.entries(vars);
  if (entries.length === 0) {
    log("env vars: none configured; skipping.");
    return;
  }
  const lines = entries.map(([k, v]) => `export ${k}=${v}`);
  appendFileSync(envFile, lines.join("\n") + "\n");
  log(`env vars: wrote ${Object.keys(vars).join(", ")} to $CLAUDE_ENV_FILE.`);
}

// --- Step 2: project dependencies ------------------------------------------
// Sandi is an npm project (package-lock.json present). `npm install` also runs
// the repo's `prepare` script, which points git at the checked-in .githooks/,
// and provides the `pi` CLI plus tsx that the dev and verify scripts shell out
// to. The detection list stays generic so this file is reusable, but in
// practice only the package.json branch fires here.
function installDeps() {
  const managers = [
    { manifest: "package.json", cmd: ["npm", "install"] },
    { manifest: "Cargo.toml", cmd: ["cargo", "fetch"] },
    { manifest: "go.mod", cmd: ["go", "mod", "download"] },
    { manifest: "requirements.txt", cmd: ["pip", "install", "-r", "requirements.txt"] },
    { manifest: "Gemfile", cmd: ["bundle", "install"] },
  ];
  const ran = managers.filter(({ manifest }) => existsSync(join(repoRoot, manifest)));
  if (ran.length === 0) {
    log("deps: no recognized package manifest in repo; skipping.");
    return;
  }
  for (const { manifest, cmd } of ran) {
    try {
      runInstall(cmd);
      log(`deps: installed for ${manifest}.`);
    } catch (err) {
      log(`deps: ${cmd[0]} failed for ${manifest} (${err.message}); continuing.`);
    }
  }
}

// Run a package-manager command, robust to Windows. Node's execFileSync does
// not resolve `npm` (a .cmd shim) without a shell on Windows, so a plain call
// ENOENTs there; on ENOENT we retry through the shell (execSync with a command
// string, which avoids the args-with-shell deprecation). The commands here are
// fixed with simple args, so shell quoting is not a concern.
function runInstall(cmd) {
  try {
    execFileSync(cmd[0], cmd.slice(1), { cwd: repoRoot, stdio: "inherit" });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    execSync(cmd.join(" "), { cwd: repoRoot, stdio: "inherit" });
  }
}

log(`starting (${isCloud ? "cloud" : "local"} session, root ${repoRoot}).`);
writeEnvVars();
installDeps();
log("done.");
