import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissingPathError } from "@/lib/fs-errors";
import {
  type ProcessRunResult,
  runBoundedProcess,
} from "@/surfaces/api/client/process-runner";

const START_GRACE_MS = 30_000;
const CLEANUP_GRACE_MS = 5_000;
const POLL_MS = 25;

type SupervisorPaths = {
  started: string;
  stopped: string;
  cancel: string;
  stdout: string;
  stderr: string;
  result: string;
  resultTemp: string;
  clipboardRequest: string;
  clipboardReady: string;
  clipboardRestore: string;
  clipboardRestored: string;
};

export async function runSupervisedAutoIt(input: {
  executable: string;
  artifact: string;
  runDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
  elevation: "require_admin" | "inherit";
  signal?: AbortSignal;
}): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  if (input.signal?.aborted) return emptyResult("cancelled", startedAt);
  const wrapper = join(input.runDir, "elevated-supervisor.au3");
  const paths = supervisorPaths(input.runDir);
  await writeFile(
    wrapper,
    autoItSupervisorSource({
      executable: input.executable,
      artifact: input.artifact,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputChars: input.maxOutputChars,
      elevation: input.elevation,
      paths,
    }),
    "utf8",
  );

  const launcherController = new AbortController();
  let launcherResult: ProcessRunResult | undefined;
  const launcher = runBoundedProcess({
    executable: input.executable,
    args: ["/ErrorStdOut", wrapper],
    cwd: input.cwd,
    env: {
      ...input.env,
      SANDI_AUTOIT_CLIPBOARD_REQUEST: paths.clipboardRequest,
      SANDI_AUTOIT_CLIPBOARD_READY: paths.clipboardReady,
      SANDI_AUTOIT_CLIPBOARD_RESTORE: paths.clipboardRestore,
      SANDI_AUTOIT_CLIPBOARD_RESTORED: paths.clipboardRestored,
    },
    timeoutMs: input.timeoutMs + CLEANUP_GRACE_MS,
    maxOutputChars: input.maxOutputChars,
    signal: launcherController.signal,
  });
  void launcher.then((result) => {
    launcherResult = result;
  });
  let result: ProcessRunResult;
  try {
    result = await waitForSupervisor({
      paths,
      startedAt,
      timeoutMs: input.timeoutMs,
      launcherResult: () => launcherResult,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } finally {
    launcherController.abort();
    await launcher;
  }
  return { ...result, durationMs: Date.now() - startedAt };
}

export function autoItSupervisorSource(input: {
  executable: string;
  artifact: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  elevation: "require_admin" | "inherit";
  paths: SupervisorPaths;
}): string {
  const command = `"${input.executable}" /ErrorStdOut "${input.artifact}"`;
  return `${input.elevation === "require_admin" ? "#RequireAdmin\n" : ""}#NoTrayIcon
#include <AutoItConstants.au3>
#include <FileConstants.au3>

Global Const $g_Command = ${autoItString(command)}
Global Const $g_Cwd = ${autoItString(input.cwd)}
Global Const $g_StartedPath = ${autoItString(input.paths.started)}
Global Const $g_StoppedPath = ${autoItString(input.paths.stopped)}
Global Const $g_CancelPath = ${autoItString(input.paths.cancel)}
Global Const $g_StdoutPath = ${autoItString(input.paths.stdout)}
Global Const $g_StderrPath = ${autoItString(input.paths.stderr)}
Global Const $g_ResultPath = ${autoItString(input.paths.result)}
Global Const $g_ResultTempPath = ${autoItString(input.paths.resultTemp)}
Global Const $g_ClipboardRequestPath = ${autoItString(input.paths.clipboardRequest)}
Global Const $g_ClipboardReadyPath = ${autoItString(input.paths.clipboardReady)}
Global Const $g_ClipboardRestorePath = ${autoItString(input.paths.clipboardRestore)}
Global Const $g_ClipboardRestoredPath = ${autoItString(input.paths.clipboardRestored)}
Global Const $g_TimeoutMs = ${input.timeoutMs}
Global Const $g_MaxOutputChars = ${input.maxOutputChars}
Global $g_ChildPid = 0
Global $g_StdoutHandle = -1
Global $g_StderrHandle = -1
Global $g_StdoutChars = 0
Global $g_StderrChars = 0
Global $g_StdoutTruncated = False
Global $g_StderrTruncated = False
Global Const $g_MaxClipboardFormats = 128
Global $g_ClipboardFormats[$g_MaxClipboardFormats]
Global $g_ClipboardHandles[$g_MaxClipboardFormats]
Global $g_ClipboardFormatCount = 0
Global $g_ClipboardCaptured = False

OnAutoItExitRegister("_SandiCleanup")
_SandiMain()
Exit 0

Func _SandiMain()
    FileWrite($g_StartedPath, "pid=" & @AutoItPID & ";admin=" & IsAdmin() & @CRLF)
    If FileExists($g_CancelPath) Then
        _SandiWriteResult("cancelled", "null")
        Return
    EndIf

    $g_StdoutHandle = FileOpen($g_StdoutPath, BitOR($FO_OVERWRITE, $FO_UTF8_NOBOM))
    $g_StderrHandle = FileOpen($g_StderrPath, BitOR($FO_OVERWRITE, $FO_UTF8_NOBOM))
    If $g_StdoutHandle = -1 Or $g_StderrHandle = -1 Then
        _SandiWriteResult("spawn_error", "null")
        Return
    EndIf

    $g_ChildPid = Run($g_Command, $g_Cwd, @SW_HIDE, BitOR($STDOUT_CHILD, $STDERR_CHILD))
    If $g_ChildPid = 0 Then
        FileWrite($g_StderrHandle, "elevated AutoIt supervisor could not start the script")
        _SandiWriteResult("spawn_error", "null")
        Return
    EndIf

    Local $started = TimerInit()
    While True
        _SandiClipboardTick()
        _SandiCapture($g_StdoutHandle, StdoutRead($g_ChildPid), $g_StdoutChars, $g_StdoutTruncated)
        _SandiCapture($g_StderrHandle, StderrRead($g_ChildPid), $g_StderrChars, $g_StderrTruncated)

        If FileExists($g_CancelPath) Then
            Local $cancelPid = $g_ChildPid
            If Not _SandiKillTree($cancelPid) Then
                FileWrite($g_StderrHandle, "elevated AutoIt supervisor could not terminate the script tree")
                _SandiWriteResult("spawn_error", "null")
                Return
            EndIf
            _SandiDrain($cancelPid)
            $g_ChildPid = 0
            _SandiClipboardRestore()
            _SandiWriteResult("cancelled", "null")
            Return
        EndIf
        If TimerDiff($started) >= $g_TimeoutMs Then
            Local $timeoutPid = $g_ChildPid
            If Not _SandiKillTree($timeoutPid) Then
                FileWrite($g_StderrHandle, "elevated AutoIt supervisor could not terminate the timed-out script tree")
                _SandiWriteResult("spawn_error", "null")
                Return
            EndIf
            _SandiDrain($timeoutPid)
            $g_ChildPid = 0
            _SandiClipboardRestore()
            _SandiWriteResult("timed_out", "null")
            Return
        EndIf
        ; AutoIt treats a fractional timeout as zero, which waits forever.
        If ProcessWaitClose($g_ChildPid, 1) Then
            Local $exitCode = @extended
            Local $finishedPid = $g_ChildPid
            _SandiDrain($finishedPid)
            $g_ChildPid = 0
            _SandiClipboardRestore()
            _SandiWriteResult("completed", String($exitCode))
            Return
        EndIf
    WEnd
EndFunc

Func _SandiCapture($handle, $chunk, ByRef $chars, ByRef $truncated)
    Local $chunkChars = StringLen($chunk)
    If $chunkChars = 0 Then Return
    Local $remaining = $g_MaxOutputChars - $chars
    If $remaining > 0 Then
        Local $kept = StringLeft($chunk, $remaining)
        FileWrite($handle, $kept)
        $chars += StringLen($kept)
    EndIf
    If $chunkChars > $remaining Then $truncated = True
EndFunc

Func _SandiDrain($pid)
    Local $idleReads = 0
    For $attempt = 1 To 100
        Local $stdout = StdoutRead($pid)
        _SandiCapture($g_StdoutHandle, $stdout, $g_StdoutChars, $g_StdoutTruncated)
        Local $stderr = StderrRead($pid)
        _SandiCapture($g_StderrHandle, $stderr, $g_StderrChars, $g_StderrTruncated)
        If StringLen($stdout) = 0 And StringLen($stderr) = 0 Then
            $idleReads += 1
            If $idleReads >= 5 Then Return
        Else
            $idleReads = 0
        EndIf
        Sleep(10)
    Next
EndFunc

Func _SandiKillTree($pid)
    _SandiReleaseInput()
    RunWait('"' & @SystemDir & '\\taskkill.exe" /PID ' & $pid & ' /T /F', "", @SW_HIDE)
    If ProcessExists($pid) Then ProcessClose($pid)
    ProcessWaitClose($pid, 2)
    _SandiClipboardRestore()
    Return Not ProcessExists($pid)
EndFunc

Func _SandiClipboardTick()
    If Not $g_ClipboardCaptured And FileExists($g_ClipboardRequestPath) Then
        Local $status = "error"
        If _SandiClipboardCapture() Then $status = "ok"
        FileWrite($g_ClipboardReadyPath, $status)
    EndIf
    If $g_ClipboardCaptured And FileExists($g_ClipboardRestorePath) Then
        Local $restored = _SandiClipboardRestore()
        If $restored Then
            FileWrite($g_ClipboardRestoredPath, "ok")
        Else
            FileWrite($g_ClipboardRestoredPath, "error")
        EndIf
    EndIf
EndFunc

Func _SandiClipboardCapture()
    If Not _SandiOpenClipboard() Then Return False
    $g_ClipboardFormatCount = 0
    Local $format = 0
    While $g_ClipboardFormatCount < $g_MaxClipboardFormats
        Local $nextFormat = DllCall("user32.dll", "uint", "EnumClipboardFormats", "uint", $format)
        If @error Or $nextFormat[0] = 0 Then ExitLoop
        $format = $nextFormat[0]
        Local $source = DllCall("user32.dll", "handle", "GetClipboardData", "uint", $format)
        If @error Or Not $source[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        Local $copy = DllCall("ole32.dll", "handle", "OleDuplicateData", "handle", $source[0], "uint", $format, "uint", 0)
        If @error Or Not $copy[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        $g_ClipboardFormats[$g_ClipboardFormatCount] = $format
        $g_ClipboardHandles[$g_ClipboardFormatCount] = $copy[0]
        $g_ClipboardFormatCount += 1
    WEnd
    If $g_ClipboardFormatCount = $g_MaxClipboardFormats Then
        Local $extra = DllCall("user32.dll", "uint", "EnumClipboardFormats", "uint", $format)
        If Not @error And $extra[0] <> 0 Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
    EndIf
    DllCall("user32.dll", "bool", "CloseClipboard")
    $g_ClipboardCaptured = True
    Return True
EndFunc

Func _SandiClipboardRestore()
    If Not $g_ClipboardCaptured Then Return True
    If Not _SandiOpenClipboard() Then Return False
    Local $empty = DllCall("user32.dll", "bool", "EmptyClipboard")
    If @error Or Not $empty[0] Then
        DllCall("user32.dll", "bool", "CloseClipboard")
        Return False
    EndIf
    For $index = 0 To $g_ClipboardFormatCount - 1
        Local $set = DllCall("user32.dll", "handle", "SetClipboardData", "uint", $g_ClipboardFormats[$index], "handle", $g_ClipboardHandles[$index])
        If @error Or Not $set[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        $g_ClipboardHandles[$index] = 0
    Next
    DllCall("user32.dll", "bool", "CloseClipboard")
    $g_ClipboardFormatCount = 0
    $g_ClipboardCaptured = False
    Return True
EndFunc

Func _SandiOpenClipboard()
    Local $timer = TimerInit()
    Do
        Local $opened = DllCall("user32.dll", "bool", "OpenClipboard", "hwnd", 0)
        If Not @error And $opened[0] Then Return True
        Sleep(10)
    Until TimerDiff($timer) >= 2000
    Return False
EndFunc

Func _SandiReleaseInput()
    Local $keys[5] = [0x10, 0x11, 0x12, 0x5B, 0x5C]
    For $index = 0 To UBound($keys) - 1
        DllCall("user32.dll", "none", "keybd_event", "byte", $keys[$index], "byte", 0, "dword", 2, "ulong_ptr", 0)
    Next
    MouseUp("left")
    MouseUp("right")
    MouseUp("middle")
    BlockInput($BI_ENABLE)
EndFunc

Func _SandiWriteResult($kind, $exitCode)
    _SandiCloseOutputs()
    Local $handle = FileOpen($g_ResultTempPath, BitOR($FO_OVERWRITE, $FO_UTF8_NOBOM))
    If $handle = -1 Then Return
    FileWrite($handle, "kind=" & $kind & @LF)
    FileWrite($handle, "exitCode=" & $exitCode & @LF)
    FileWrite($handle, "stdoutTruncated=" & Number($g_StdoutTruncated) & @LF)
    FileWrite($handle, "stderrTruncated=" & Number($g_StderrTruncated) & @LF)
    FileWrite($handle, "complete=1" & @LF)
    FileClose($handle)
    FileMove($g_ResultTempPath, $g_ResultPath, $FC_OVERWRITE)
EndFunc

Func _SandiCloseOutputs()
    If $g_StdoutHandle <> -1 Then FileClose($g_StdoutHandle)
    If $g_StderrHandle <> -1 Then FileClose($g_StderrHandle)
    $g_StdoutHandle = -1
    $g_StderrHandle = -1
EndFunc

Func _SandiCleanup()
    If $g_ChildPid <> 0 And ProcessExists($g_ChildPid) Then _SandiKillTree($g_ChildPid)
    _SandiClipboardRestore()
    _SandiReleaseInput()
    _SandiCloseOutputs()
    FileChangeDir(@TempDir)
    FileWrite($g_StoppedPath, "pid=" & @AutoItPID & @CRLF)
EndFunc
`;
}

async function waitForSupervisor(input: {
  paths: SupervisorPaths;
  startedAt: number;
  timeoutMs: number;
  launcherResult: () => ProcessRunResult | undefined;
  signal?: AbortSignal;
}): Promise<ProcessRunResult> {
  const deadline = input.startedAt + input.timeoutMs;
  const startupDeadline = Math.min(deadline, Date.now() + START_GRACE_MS);
  let hasStarted = false;
  while (true) {
    const rawResult = await readOptional(input.paths.result);
    if (rawResult !== undefined) {
      return finishSupervisor(rawResult, input.paths, input.startedAt);
    }
    if (input.signal?.aborted) {
      return stopSupervisor("cancelled", input.paths, input.startedAt);
    }
    if (Date.now() >= deadline) {
      return stopSupervisor("timed_out", input.paths, input.startedAt);
    }
    if (!hasStarted) {
      const launcher = input.launcherResult();
      if (
        launcher !== undefined &&
        (launcher.kind === "spawn_error" || launcher.exitCode !== 0)
      ) {
        return supervisorFailure(
          input.startedAt,
          launcher.error ||
            launcher.stderr ||
            launcher.stdout ||
            "elevation launcher failed",
        );
      }
      hasStarted = (await readOptional(input.paths.started)) !== undefined;
      if (!hasStarted && Date.now() >= startupDeadline) {
        await requestStop(input.paths.cancel);
        return supervisorFailure(
          input.startedAt,
          "administrator elevation was declined or did not start",
        );
      }
    }
    await delay(POLL_MS);
  }
}

async function stopSupervisor(
  kind: "cancelled" | "timed_out",
  paths: SupervisorPaths,
  startedAt: number,
): Promise<ProcessRunResult> {
  await requestStop(paths.cancel);
  const deadline = Date.now() + CLEANUP_GRACE_MS;
  while (Date.now() < deadline) {
    const rawResult = await readOptional(paths.result);
    if (rawResult !== undefined) {
      const stopped = await finishSupervisor(rawResult, paths, startedAt);
      if (stopped.kind === "spawn_error") return stopped;
      return { ...stopped, kind, durationMs: Date.now() - startedAt };
    }
    await delay(POLL_MS);
  }
  return {
    kind,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs: Date.now() - startedAt,
    error: "elevated AutoIt supervisor did not acknowledge cleanup",
  };
}

async function finishSupervisor(
  raw: string,
  paths: SupervisorPaths,
  startedAt: number,
): Promise<ProcessRunResult> {
  const result = await readSupervisorResult(raw, paths, startedAt);
  const deadline = Date.now() + CLEANUP_GRACE_MS;
  while (Date.now() < deadline) {
    if ((await readOptional(paths.stopped)) !== undefined) return result;
    await delay(POLL_MS);
  }
  return supervisorFailure(
    startedAt,
    "elevated AutoIt supervisor did not finish cleanup",
  );
}

async function readSupervisorResult(
  raw: string,
  paths: SupervisorPaths,
  startedAt: number,
): Promise<ProcessRunResult> {
  const match =
    /^kind=(completed|timed_out|cancelled|spawn_error)\r?\nexitCode=(null|-?\d+)\r?\nstdoutTruncated=([01])\r?\nstderrTruncated=([01])\r?\ncomplete=1\r?\n?$/.exec(
      raw,
    );
  if (!match)
    return supervisorFailure(startedAt, "supervisor result was malformed");
  const [, rawKind, exitCode, stdoutTruncated, stderrTruncated] = match;
  if (
    rawKind === undefined ||
    exitCode === undefined ||
    stdoutTruncated === undefined ||
    stderrTruncated === undefined
  ) {
    return supervisorFailure(startedAt, "supervisor result was incomplete");
  }
  const kind = processResultKind(rawKind);
  if (kind === undefined) {
    return supervisorFailure(startedAt, "supervisor result kind was invalid");
  }
  const [stdout, stderr] = await Promise.all([
    readOptional(paths.stdout),
    readOptional(paths.stderr),
  ]);
  return {
    kind,
    exitCode: exitCode === "null" ? null : Number(exitCode),
    signal: null,
    stdout: (stdout ?? "").trimEnd(),
    stderr: (stderr ?? "").trimEnd(),
    truncated: stdoutTruncated === "1" || stderrTruncated === "1",
    durationMs: Date.now() - startedAt,
    ...(kind === "spawn_error"
      ? { error: stderr || "elevated AutoIt supervisor failed" }
      : {}),
  };
}

function processResultKind(
  value: string,
): ProcessRunResult["kind"] | undefined {
  switch (value) {
    case "completed":
    case "timed_out":
    case "cancelled":
    case "spawn_error":
      return value;
    default:
      return undefined;
  }
}

function supervisorPaths(runDir: string): SupervisorPaths {
  return {
    started: join(runDir, "supervisor.started"),
    stopped: join(runDir, "supervisor.stopped"),
    cancel: join(runDir, "supervisor.cancel"),
    stdout: join(runDir, "stdout.txt"),
    stderr: join(runDir, "stderr.txt"),
    result: join(runDir, "supervisor.result"),
    resultTemp: join(runDir, "supervisor.result.tmp"),
    clipboardRequest: join(runDir, "clipboard.request"),
    clipboardReady: join(runDir, "clipboard.ready"),
    clipboardRestore: join(runDir, "clipboard.restore"),
    clipboardRestored: join(runDir, "clipboard.restored"),
  };
}

function emptyResult(
  kind: ProcessRunResult["kind"],
  startedAt: number,
): ProcessRunResult {
  return {
    kind,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs: Date.now() - startedAt,
  };
}

function supervisorFailure(startedAt: number, error: string): ProcessRunResult {
  return {
    kind: "spawn_error",
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    durationMs: Date.now() - startedAt,
    error,
  };
}

async function requestStop(path: string): Promise<void> {
  await writeFile(path, "cancel\n", "utf8");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
