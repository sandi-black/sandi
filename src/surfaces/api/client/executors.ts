import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";

import { errorMessage } from "@/lib/errors";
import { isMissingPathError } from "@/lib/fs-errors";
import { compileBoundedRegex } from "@/surfaces/api/client/bounded-regex";
import { desktopActivity } from "@/surfaces/api/client/desktop-activity";
import { transferDesktopFile } from "@/surfaces/api/client/desktop-file-transfer";
import {
  listMonitors,
  listWindows,
  screenshot,
} from "@/surfaces/api/client/desktop-state";
import {
  type LocalScriptRuntimeContext,
  runLocalAutoIt,
  runLocalJavaScript,
} from "@/surfaces/api/client/local-script-runtimes";
import type {
  BrokerCall,
  LocalBashParams,
  LocalEditParams,
  LocalGlobParams,
  LocalGrepParams,
  LocalLsParams,
  LocalReadParams,
  LocalWriteParams,
  ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";
import { MAX_LOCAL_BASH_TIMEOUT_MS } from "@/surfaces/api/devices/protocol";

// The desktop side of hands-local: the real file and shell operations a paired
// desktop runs on the human's behalf. The call arrives already parsed as a
// BrokerCall (the wire boundary validated tool and params together), so each
// executor receives typed params and acts on the local machine. By design there
// is no path sandbox: pairing a desktop grants Sandi the same reach the human
// has there, the same trust model as running a coding agent locally. The only
// rails are output and time caps so one call cannot flood the model or hang the
// link.

const MAX_OUTPUT_CHARS = 100_000;
const MAX_LIST_ENTRIES = 1_000;
const MAX_MATCH_RESULTS = 1_000;
const MAX_WALK_ENTRIES = 50_000;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
// Grace between SIGTERM and the escalated SIGKILL for a command that ignores the
// term. Short: the command is already past its deadline or cancelled.
const KILL_GRACE_MS = 2_000;
// Once both tree-kill attempts have run, stop waiting on inherited pipes from
// descendants that escaped the process tree. A remote caller must always get a
// bounded answer even when the operating system never emits `close`.
const KILL_SETTLEMENT_GRACE_MS = 1_000;

// Pi may issue independent tool calls concurrently. Edits to one real file must
// still observe each other's result, including when callers name that file
// through different symlink paths, or a later write can silently erase an
// earlier one.
const fileMutationQueues = new Map<string, Promise<void>>();

export type ExecutorContext = {
  // Relative paths resolve against this directory; absolute paths are used as
  // given. Defaults to where the client was launched.
  rootDir: string;
  localScriptRuntimes?: LocalScriptRuntimeContext;
};

export async function executeLocalTool(
  call: BrokerCall,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  // A cancel that arrives before the call is dequeued skips it entirely. The
  // long-running tools (glob, grep, bash) also honor the signal mid-flight; the
  // bounded ones (read, write, edit, ls) are left to finish once started so a
  // cancel cannot tear a half-written file.
  if (signal?.aborted) return refused("cancelled");
  try {
    switch (call.tool) {
      case "local_read":
        return await readLocal(call.params, context);
      case "local_write":
        return await writeLocal(call.params, context);
      case "local_edit":
        return await editLocal(call.params, context);
      case "local_ls":
        return await listLocal(call.params, context);
      case "local_glob":
        return await globLocal(call.params, context, signal);
      case "local_grep":
        return await grepLocal(call.params, context, signal);
      case "local_bash":
        return await bashLocal(call.params, context, signal);
      case "local_js_run":
        return context.localScriptRuntimes
          ? await runLocalJavaScript(
              call.params,
              context.rootDir,
              context.localScriptRuntimes,
              signal,
            )
          : refused("the Sandi desktop JavaScript runtime is unavailable");
      case "local_autoit_run":
        return context.localScriptRuntimes
          ? await runLocalAutoIt(
              call.params,
              context.rootDir,
              context.localScriptRuntimes,
              signal,
            )
          : refused("the bundled AutoIt runtime is unavailable");
      case "local_list_desktops":
        // The broker answers this from its registry and never dispatches it to a
        // desktop; this case only keeps the switch exhaustive.
        return refused("local_list_desktops is resolved server-side");
      case "local_list_monitors":
        return await listMonitors(signal);
      case "local_list_windows":
        return await listWindows(signal);
      case "local_desktop_activity":
        return await desktopActivity(signal);
      case "local_screenshot":
        return await screenshot(call.params, signal);
      case "local_transfer_file":
        return await transferDesktopFile(call.params, context.rootDir, signal);
      case "local_mcp":
      case "local_mcp_configure":
        return refused("desktop MCP requires the Sandi desktop app");
    }
  } catch (error) {
    return refused(errorMessage(error));
  }
}

async function readLocal(
  params: LocalReadParams,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const path = resolvePath(context, params.path);
  const content = await readBoundedUtf8File(path);
  const lines = content.split("\n");
  const offset = params.offset ?? 0;
  const end = params.limit !== undefined ? offset + params.limit : lines.length;
  const slice = lines.slice(offset, end);
  const numbered = slice
    .map((line, index) => `${offset + index + 1}\t${line}`)
    .join("\n");
  return ok(numbered.length > 0 ? numbered : "(empty file)");
}

async function writeLocal(
  params: LocalWriteParams,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const path = resolvePath(context, params.path);
  return withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    const bytes = Buffer.byteLength(params.content, "utf8");
    return ok(`wrote ${bytes} bytes to ${path}`);
  });
}

async function editLocal(
  params: LocalEditParams,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const path = resolvePath(context, params.path);
  return withFileMutationQueue(path, async (canonicalPath) => {
    const content = await readBoundedUtf8File(canonicalPath);
    const occurrences = countOccurrences(content, params.oldString);
    if (occurrences === 0) {
      return refused("oldString was not found in the file");
    }
    if (occurrences > 1 && params.replaceAll !== true) {
      return refused(
        `oldString is not unique (${occurrences} matches); pass replaceAll to replace every one`,
      );
    }
    const next =
      params.replaceAll === true
        ? content.split(params.oldString).join(params.newString)
        : content.replace(params.oldString, params.newString);
    await replaceFileAtomically(canonicalPath, next);
    return ok(`replaced ${occurrences} occurrence(s) in ${path}`);
  });
}

async function withFileMutationQueue<T>(
  path: string,
  run: (canonicalPath: string) => Promise<T>,
): Promise<T> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    canonicalPath = resolve(path);
  }
  const prior = fileMutationQueues.get(canonicalPath) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = prior.then(() => gate);
  fileMutationQueues.set(canonicalPath, tail);
  await prior;
  try {
    return await run(canonicalPath);
  } finally {
    release();
    if (fileMutationQueues.get(canonicalPath) === tail) {
      fileMutationQueues.delete(canonicalPath);
    }
  }
}

async function replaceFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const stats = await stat(path);
  const temp = join(
    dirname(path),
    `.sandi-edit-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      mode: stats.mode & 0o7777,
    });
    await rename(temp, path);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `could not replace ${path} or remove its temporary file`,
      );
    }
    throw error;
  }
}

async function listLocal(
  params: LocalLsParams,
  context: ExecutorContext,
): Promise<ToolCallOutcome> {
  const path = resolvePath(context, params.path);
  const names: string[] = [];
  let truncated = false;
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (names.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
    names.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  const note = truncated ? "\n(listing truncated; more entries exist)" : "";
  return ok(`${names.join("\n")}${note}`);
}

async function globLocal(
  params: LocalGlobParams,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const base = resolvePath(context, params.path ?? ".");
  // A missing or non-directory base is a failed call, not an empty match set, so
  // refuse rather than return "(no files matched)" for a path that is not there.
  let baseStat: Stats;
  try {
    baseStat = await stat(base);
  } catch (error) {
    return refused(`cannot read ${base}: ${errorMessage(error)}`);
  }
  if (!baseStat.isDirectory()) return refused(`not a directory: ${base}`);

  const matcher = globToRegExp(params.pattern);
  const matches: string[] = [];
  const skipped: string[] = [];
  const traversal = newWalkState();
  let resultLimitReached = false;
  for await (const file of walkFiles(base, skipped, traversal, signal)) {
    if (signal?.aborted) return refused("cancelled");
    const rel = toPosix(relative(base, file));
    if (matcher.test(rel)) {
      matches.push(rel);
      if (matches.length >= MAX_MATCH_RESULTS) {
        resultLimitReached = true;
        break;
      }
    }
  }
  if (signal?.aborted || traversal.cancelled) return refused("cancelled");
  matches.sort((a, b) => a.localeCompare(b));
  const note = searchNotes(skipped, traversal, resultLimitReached);
  if (matches.length === 0) return ok(`(no files matched)${note}`);
  return ok(`${matches.join("\n")}${note}`);
}

async function grepLocal(
  params: LocalGrepParams,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  let regex: ReturnType<typeof compileBoundedRegex>;
  try {
    regex = compileBoundedRegex(params.pattern, params.ignoreCase);
  } catch (error) {
    return refused(errorMessage(error));
  }
  const base = resolvePath(context, params.path ?? ".");
  const fileFilter =
    params.glob !== undefined ? globToRegExp(params.glob) : undefined;
  const results: string[] = [];
  const skipped: string[] = [];
  const traversal = newWalkState();
  let resultLimitReached = false;
  let resultChars = 0;
  let skippedFiles = 0;

  const searchFile = async (file: string, label: string): Promise<void> => {
    let content: string;
    try {
      content = await readBoundedUtf8File(file);
    } catch {
      skippedFiles += 1;
      return;
    }
    if (hasNullByte(content)) return; // skip binary files
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (regex.test(line)) {
        const rendered = `${label}:${index + 1}:${line}`;
        const available = Math.max(0, MAX_OUTPUT_CHARS - resultChars);
        if (available === 0) {
          resultLimitReached = true;
          return;
        }
        const bounded = rendered.slice(0, available);
        results.push(bounded);
        resultChars += bounded.length + 1;
        if (
          bounded.length < rendered.length ||
          results.length >= MAX_MATCH_RESULTS
        ) {
          resultLimitReached = true;
          return;
        }
      }
    }
  };

  const stats = await stat(base);
  if (stats.isFile()) {
    await searchFile(base, base);
  } else {
    for await (const file of walkFiles(base, skipped, traversal, signal)) {
      if (signal?.aborted) return refused("cancelled");
      const rel = toPosix(relative(base, file));
      if (fileFilter && !fileFilter.test(rel)) continue;
      await searchFile(file, rel);
      if (resultLimitReached) break;
    }
  }
  if (signal?.aborted || traversal.cancelled) return refused("cancelled");
  const note = searchNotes(
    skipped,
    traversal,
    resultLimitReached,
    skippedFiles,
  );
  if (results.length === 0) return ok(`(no matches)${note}`);
  return ok(`${results.join("\n")}${note}`);
}

function bashLocal(
  params: LocalBashParams,
  context: ExecutorContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  if (signal?.aborted) return Promise.resolve(refused("cancelled"));
  const cwd =
    params.cwd !== undefined
      ? resolvePath(context, params.cwd)
      : context.rootDir;
  const timeoutMs = Math.min(
    MAX_LOCAL_BASH_TIMEOUT_MS,
    params.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
  );

  return new Promise((resolveRun) => {
    // shell: true runs the command through the platform shell (cmd.exe on
    // Windows, /bin/sh elsewhere), matching what a local operator would get.
    // detached on POSIX puts the shell and whatever it forks in their own
    // process group so a cancel can signal the whole group, not just the shell
    // wrapper (which would orphan the real command and leave it holding the
    // output pipe open). Windows has no process groups here; killTree uses
    // taskkill /t instead, so detached would only spawn a stray console window.
    const child = spawn(params.command, {
      shell: true,
      cwd,
      detached: process.platform !== "win32",
    });
    const output = createBoundedTextCapture(MAX_OUTPUT_CHARS);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminationStarted = false;
    let finishedOutput: { text: string; truncated: boolean } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settlementBackstop: ReturnType<typeof setTimeout> | undefined;

    function finishOutput(): { text: string; truncated: boolean } {
      if (finishedOutput !== undefined) return finishedOutput;
      output.append(stdoutDecoder.end());
      output.append(stderrDecoder.end());
      finishedOutput = output.finish();
      return finishedOutput;
    }

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (settlementBackstop) clearTimeout(settlementBackstop);
      signal?.removeEventListener("abort", onAbort);
    }

    function settle(outcome: ToolCallOutcome): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRun(outcome);
    }

    function stoppedOutcome(): ToolCallOutcome {
      if (cancelled) return refused("cancelled");
      const body = finishOutput();
      const detail = `command timed out after ${timeoutMs}ms`;
      return refused(
        truncate(
          body.text ? `${detail}\n\n${body.text}` : detail,
          body.truncated,
        ),
      );
    }

    // One termination sequence owns both signals and the final settlement
    // backstop. Timeout and abort can race, but must not create competing kill
    // timers or leave an earlier timer outside cleanup's reach.
    function terminate(): void {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      killTree(child, "SIGTERM");
      escalation = setTimeout(() => {
        killTree(child, "SIGKILL");
        settlementBackstop = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle(stoppedOutcome());
        }, KILL_SETTLEMENT_GRACE_MS);
      }, KILL_GRACE_MS);
    }

    // If the turn aborts or the link drops, kill the command rather than let it
    // run on past a result no one is waiting for.
    function onAbort(): void {
      cancelled = true;
      terminate();
    }

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      output.append(stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      output.append(stderrDecoder.write(chunk));
    });
    child.on("error", (error) => {
      settle(refused(errorMessage(error)));
    });
    child.on("close", (code) => {
      if (cancelled) {
        settle(refused("cancelled"));
        return;
      }
      const body = finishOutput();
      if (timedOut) {
        // A timeout means the command never finished: a failed call, not a
        // result. Carry any partial output in the error so evidence survives.
        const detail = `command timed out after ${timeoutMs}ms`;
        settle(
          refused(
            truncate(
              body.text ? `${detail}\n\n${body.text}` : detail,
              body.truncated,
            ),
          ),
        );
        return;
      }
      // A non-zero exit is normal tool evidence (a failing test, grep finding
      // nothing), not a failed call. The exit code and output are exactly what
      // the model needs, so the run is ok and the code travels in the output.
      const header = `exit code: ${code ?? "none"}`;
      settle(
        ok(body.text ? `${header}\n\n${body.text}` : header, body.truncated),
      );
    });
  });
}

type BoundedTextCapture = {
  append(value: string): void;
  finish(): { text: string; truncated: boolean };
};

function createBoundedTextCapture(maxChars: number): BoundedTextCapture {
  let text = "";
  let started = false;
  let discardedNonWhitespace = false;
  return {
    append(value: string): void {
      let remainingValue = value;
      if (!started) {
        remainingValue = remainingValue.trimStart();
        if (remainingValue.length === 0) return;
        started = true;
      }
      const available = Math.max(0, maxChars - text.length);
      if (available > 0) {
        text += remainingValue.slice(0, available);
        remainingValue = remainingValue.slice(available);
      }
      if (remainingValue.trim().length > 0) {
        discardedNonWhitespace = true;
      }
    },
    finish(): { text: string; truncated: boolean } {
      return {
        text: discardedNonWhitespace ? text : text.trimEnd(),
        truncated: discardedNonWhitespace,
      };
    },
  };
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
    killChildDirectly(child, signal);
    return;
  }
  if (process.platform === "win32") {
    // taskkill /f is already a forced kill, so it covers both the polite and the
    // escalated step. A command can fail after spawning (for example, an access
    // error), so both launch failures and non-zero exits fall back to the child
    // process handle. The fallback is idempotent because Windows can report an
    // error and a terminal event for the same failed launch.
    const killer = spawn(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore" },
    );
    let fallbackStarted = false;
    const fallback = (): void => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      killChildDirectly(child, signal);
    };
    killer.once("error", fallback);
    killer.once("exit", (code, killerSignal) => {
      if (code !== 0 || killerSignal !== null) fallback();
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or the child was never a group leader;
    // fall back to signaling the process directly.
    killChildDirectly(child, signal);
  }
}

function killChildDirectly(
  child: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    child.kill(signal);
  } catch {
    // The process may have closed between the state check and the signal. The
    // termination backstop still settles the caller if no close event arrives.
  }
}

// Walks files under `base`. A directory that cannot be read mid-walk is skipped
// (one unreadable subtree should not abort a whole-tree search) but its path is
// pushed to `skipped` so the caller can report that results may be partial
// rather than present an incomplete listing as if it were the whole truth.
type WalkState = {
  visitedEntries: number;
  truncated: boolean;
  cancelled: boolean;
};

function newWalkState(): WalkState {
  return { visitedEntries: 0, truncated: false, cancelled: false };
}

async function* walkFiles(
  base: string,
  skipped: string[],
  state: WalkState,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stack: string[] = [base];
  while (stack.length > 0) {
    if (signal?.aborted) {
      state.cancelled = true;
      return;
    }
    const dir = stack.pop();
    if (dir === undefined) break;
    try {
      const entries = await opendir(dir);
      for await (const entry of entries) {
        if (signal?.aborted) {
          state.cancelled = true;
          return;
        }
        state.visitedEntries += 1;
        if (state.visitedEntries > MAX_WALK_ENTRIES) {
          state.truncated = true;
          return;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          yield full;
        }
      }
    } catch {
      if (signal?.aborted) {
        state.cancelled = true;
        return;
      }
      skipped.push(dir);
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

// Appended to a glob or grep result whenever the search deliberately omitted
// work, so a bounded partial answer is never presented as the whole tree.
function searchNotes(
  skipped: string[],
  traversal: WalkState,
  resultLimitReached: boolean,
  skippedFiles = 0,
): string {
  const notes: string[] = [];
  if (skipped.length > 0) {
    const noun = skipped.length === 1 ? "directory" : "directories";
    notes.push(`${skipped.length} unreadable ${noun} skipped`);
  }
  if (traversal.truncated) {
    notes.push(
      `search stopped after ${MAX_WALK_ENTRIES} filesystem entries; results may be incomplete`,
    );
  }
  if (skippedFiles > 0) {
    const noun = skippedFiles === 1 ? "file" : "files";
    notes.push(
      `${skippedFiles} unreadable, non-UTF-8, or over-${MAX_TEXT_FILE_BYTES}-byte ${noun} skipped`,
    );
  }
  if (resultLimitReached) {
    notes.push(
      `search stopped after ${MAX_MATCH_RESULTS} results; more may exist`,
    );
  }
  return notes.map((note) => `\n(${note})`).join("");
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

async function readBoundedUtf8File(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `text file exceeds the ${MAX_TEXT_FILE_BYTES} byte local-tool limit`,
      );
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    await handle.close();
  }
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

function ok(output: string, wasTruncated = false): ToolCallOutcome {
  return {
    ok: true,
    content: [{ type: "text", text: truncate(output, wasTruncated) }],
  };
}

function refused(error: string): ToolCallOutcome {
  return { ok: false, content: [], error };
}

function truncate(text: string, wasTruncated = false): string {
  if (!wasTruncated && text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated to ${MAX_OUTPUT_CHARS} characters]`;
}
