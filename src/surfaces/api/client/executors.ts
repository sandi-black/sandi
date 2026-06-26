import { spawn } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  LocalBashParamsSchema,
  LocalEditParamsSchema,
  LocalGlobParamsSchema,
  LocalGrepParamsSchema,
  LocalLsParamsSchema,
  LocalReadParamsSchema,
  type LocalToolName,
  LocalWriteParamsSchema,
  type ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";

// The desktop side of hands-local: the real file and shell operations a paired
// desktop runs on the human's behalf. Each executor parses its params, acts on
// the local machine, and returns evidence. By design there is no path sandbox:
// pairing a desktop grants Sandi the same reach the human has there, the same
// trust model as running a coding agent locally. The only rails are output and
// time caps so one call cannot flood the model or hang the link.

const MAX_OUTPUT_CHARS = 100_000;
const MAX_LIST_ENTRIES = 1_000;
const MAX_MATCH_RESULTS = 1_000;
const MAX_WALK_FILES = 50_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 1_200_000;
// Grace between SIGTERM and the escalated SIGKILL for a command that ignores the
// term. Short: the command is already past its deadline or cancelled.
const KILL_GRACE_MS = 2_000;

export type ExecutorContext = {
  // Relative paths resolve against this directory; absolute paths are used as
  // given. Defaults to where the client was launched.
  rootDir: string;
};

export async function executeLocalTool(
  tool: LocalToolName,
  rawParams: unknown,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  // A cancel that arrives before the call is dequeued skips it entirely. The
  // long-running tools (glob, grep, bash) also honor the signal mid-flight; the
  // bounded ones (read, write, edit, ls) are left to finish once started so a
  // cancel cannot tear a half-written file.
  if (signal?.aborted) return refused("cancelled");
  try {
    switch (tool) {
      case "local_read":
        return await readLocal(rawParams, context);
      case "local_write":
        return await writeLocal(rawParams, context);
      case "local_edit":
        return await editLocal(rawParams, context);
      case "local_ls":
        return await listLocal(rawParams, context);
      case "local_glob":
        return await globLocal(rawParams, context, signal);
      case "local_grep":
        return await grepLocal(rawParams, context, signal);
      case "local_bash":
        return await bashLocal(rawParams, context, signal);
    }
  } catch (error) {
    return refused(errorMessage(error));
  }
}

async function readLocal(
  rawParams: unknown,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const parsed = LocalReadParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_read params");
  const path = resolvePath(context, parsed.data.path);
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  const offset = parsed.data.offset ?? 0;
  const end =
    parsed.data.limit !== undefined ? offset + parsed.data.limit : lines.length;
  const slice = lines.slice(offset, end);
  const numbered = slice
    .map((line, index) => `${offset + index + 1}\t${line}`)
    .join("\n");
  return ok(numbered.length > 0 ? numbered : "(empty file)");
}

async function writeLocal(
  rawParams: unknown,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const parsed = LocalWriteParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_write params");
  const path = resolvePath(context, parsed.data.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, parsed.data.content, "utf8");
  const bytes = Buffer.byteLength(parsed.data.content, "utf8");
  return ok(`wrote ${bytes} bytes to ${path}`);
}

async function editLocal(
  rawParams: unknown,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const parsed = LocalEditParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_edit params");
  const path = resolvePath(context, parsed.data.path);
  const content = await readFile(path, "utf8");
  const occurrences = countOccurrences(content, parsed.data.oldString);
  if (occurrences === 0) {
    return refused("oldString was not found in the file");
  }
  if (occurrences > 1 && parsed.data.replaceAll !== true) {
    return refused(
      `oldString is not unique (${occurrences} matches); pass replaceAll to replace every one`,
    );
  }
  const next =
    parsed.data.replaceAll === true
      ? content.split(parsed.data.oldString).join(parsed.data.newString)
      : content.replace(parsed.data.oldString, parsed.data.newString);
  await writeFile(path, next, "utf8");
  return ok(`replaced ${occurrences} occurrence(s) in ${path}`);
}

async function listLocal(
  rawParams: unknown,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const parsed = LocalLsParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_ls params");
  const path = resolvePath(context, parsed.data.path);
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, MAX_LIST_ENTRIES);
  const note =
    names.length > shown.length
      ? `\n(${names.length - shown.length} more entries omitted)`
      : "";
  return ok(`${shown.join("\n")}${note}`);
}

async function globLocal(
  rawParams: unknown,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const parsed = LocalGlobParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_glob params");
  const base = resolvePath(context, parsed.data.path ?? ".");
  // A missing or non-directory base is a failed call, not an empty match set, so
  // refuse rather than return "(no files matched)" for a path that is not there.
  let baseStat: Stats;
  try {
    baseStat = await stat(base);
  } catch (error) {
    return refused(`cannot read ${base}: ${errorMessage(error)}`);
  }
  if (!baseStat.isDirectory()) return refused(`not a directory: ${base}`);

  const matcher = globToRegExp(parsed.data.pattern);
  const matches: string[] = [];
  const skipped: string[] = [];
  for await (const file of walkFiles(base, skipped)) {
    if (signal?.aborted) return refused("cancelled");
    const rel = toPosix(relative(base, file));
    if (matcher.test(rel)) {
      matches.push(rel);
      if (matches.length >= MAX_MATCH_RESULTS) break;
    }
  }
  matches.sort((a, b) => a.localeCompare(b));
  const note = skippedNote(skipped);
  if (matches.length === 0) return ok(`(no files matched)${note}`);
  return ok(`${matches.join("\n")}${note}`);
}

async function grepLocal(
  rawParams: unknown,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const parsed = LocalGrepParamsSchema.safeParse(rawParams);
  if (!parsed.success) return refused("invalid local_grep params");
  let regex: RegExp;
  try {
    regex = new RegExp(parsed.data.pattern, parsed.data.ignoreCase ? "i" : "");
  } catch (error) {
    return refused(`invalid regular expression: ${errorMessage(error)}`);
  }
  const base = resolvePath(context, parsed.data.path ?? ".");
  const fileFilter =
    parsed.data.glob !== undefined ? globToRegExp(parsed.data.glob) : undefined;
  const results: string[] = [];
  const skipped: string[] = [];

  const searchFile = async (file: string, label: string): Promise<void> => {
    const content = await readFile(file, "utf8");
    if (hasNullByte(content)) return; // skip binary files
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (regex.test(line)) {
        results.push(`${label}:${index + 1}:${line}`);
        if (results.length >= MAX_MATCH_RESULTS) return;
      }
    }
  };

  const stats = await stat(base);
  if (stats.isFile()) {
    await searchFile(base, base);
  } else {
    for await (const file of walkFiles(base, skipped)) {
      if (signal?.aborted) return refused("cancelled");
      const rel = toPosix(relative(base, file));
      if (fileFilter && !fileFilter.test(rel)) continue;
      await searchFile(file, rel);
      if (results.length >= MAX_MATCH_RESULTS) break;
    }
  }
  const note = skippedNote(skipped);
  if (results.length === 0) return ok(`(no matches)${note}`);
  return ok(`${results.join("\n")}${note}`);
}

function bashLocal(
  rawParams: unknown,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const parsed = LocalBashParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return Promise.resolve(refused("invalid local_bash params"));
  }
  if (signal?.aborted) return Promise.resolve(refused("cancelled"));
  const cwd =
    parsed.data.cwd !== undefined
      ? resolvePath(context, parsed.data.cwd)
      : context.rootDir;
  const timeoutMs = Math.min(
    MAX_BASH_TIMEOUT_MS,
    parsed.data.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
  );

  return new Promise((resolveRun) => {
    // shell: true runs the command through the platform shell (cmd.exe on
    // Windows, /bin/sh elsewhere), matching what a local operator would get.
    // detached on POSIX puts the shell and whatever it forks in their own
    // process group so a cancel can signal the whole group, not just the shell
    // wrapper (which would orphan the real command and leave it holding the
    // output pipe open). Windows has no process groups here; killTree uses
    // taskkill /t instead, so detached would only spawn a stray console window.
    const child = spawn(parsed.data.command, {
      shell: true,
      cwd,
      detached: process.platform !== "win32",
    });
    const out: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    // Send SIGTERM, then escalate to an unignorable SIGKILL if the command traps
    // or ignores the term and does not exit within the grace window. Without
    // this a command can outlive its own timeout or cancel.
    const terminate = (): void => {
      killTree(child, "SIGTERM");
      escalation = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    // If the turn aborts or the link drops, kill the command rather than let it
    // run on past a result no one is waiting for.
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) =>
      out.push(chunk.toString("utf8")),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      out.push(chunk.toString("utf8")),
    );
    child.on("error", (error) => {
      cleanup();
      resolveRun(refused(errorMessage(error)));
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelled) {
        resolveRun(refused("cancelled"));
        return;
      }
      const body = out.join("").trim();
      if (timedOut) {
        // A timeout means the command never finished: a failed call, not a
        // result. Carry any partial output in the error so evidence survives.
        const detail = `command timed out after ${timeoutMs}ms`;
        resolveRun(refused(truncate(body ? `${detail}\n\n${body}` : detail)));
        return;
      }
      // A non-zero exit is normal tool evidence (a failing test, grep finding
      // nothing), not a failed call. The exit code and output are exactly what
      // the model needs, so the run is ok and the code travels in the output.
      const header = `exit code: ${code ?? "none"}`;
      resolveRun(ok(body ? `${header}\n\n${body}` : header));
    });
  });
}

// Kills a shell command and its descendants. `child.kill` signals only the
// shell wrapper, which orphans the command it forked (and on Linux leaves it
// holding the output pipe open, so the child never reports "close"). Take down
// the whole tree: taskkill /t /f on Windows, and the given signal to the
// negative pid (the process group, available because bashLocal spawns detached)
// on POSIX.
function killTree(
  child: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    // taskkill /f is already a forced kill, so it covers both the polite and the
    // escalated step. stdio ignored and the error swallowed so taskkill's own
    // failure (an already-exited pid) cannot throw into the caller.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    }).on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or the child was never a group leader;
    // fall back to signaling the process directly.
    child.kill(signal);
  }
}

// Walks files under `base`. A directory that cannot be read mid-walk is skipped
// (one unreadable subtree should not abort a whole-tree search) but its path is
// pushed to `skipped` so the caller can report that results may be partial
// rather than present an incomplete listing as if it were the whole truth.
async function* walkFiles(
  base: string,
  skipped: string[],
): AsyncGenerator<string> {
  let visited = 0;
  const stack: string[] = [base];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push(dir);
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        visited += 1;
        if (visited > MAX_WALK_FILES) return;
        yield full;
      }
    }
  }
}

// Translates a glob to an anchored regex. `**` spans path separators, `*` and
// `?` match within one segment, and every other character is matched literally.
function globToRegExp(pattern: string): RegExp {
  const posix = toPosix(pattern);
  let out = "^";
  for (let index = 0; index < posix.length; index += 1) {
    const char = posix[index] ?? "";
    if (char === "*") {
      if (posix[index + 1] === "*") {
        if (posix[index + 2] === "/") {
          // `**/` spans zero or more directories, so `src/**/*.ts` also matches
          // a file directly under src with no directory in between.
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

// Appended to a glob or grep result when the walk could not read some
// directories, so a partial listing is never mistaken for the whole truth.
function skippedNote(skipped: string[]): string {
  if (skipped.length === 0) return "";
  const noun = skipped.length === 1 ? "directory" : "directories";
  return `\n(${skipped.length} unreadable ${noun} skipped)`;
}

function resolvePath(context: ExecutorContext, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(context.rootDir, path);
}

function toPosix(path: string): string {
  return sep === "\\" ? path.split("\\").join("/") : path;
}

// True if the text contains a NUL code unit, the cheap heuristic for a binary
// file that a line-based search should skip.
function hasNullByte(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0) return true;
  }
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function ok(output: string): ToolCallOutcome {
  return { ok: true, output: truncate(output) };
}

function refused(error: string): ToolCallOutcome {
  return { ok: false, output: "", error };
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated to ${MAX_OUTPUT_CHARS} characters]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
