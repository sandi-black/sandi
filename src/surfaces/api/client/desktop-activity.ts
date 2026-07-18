import { spawn } from "node:child_process";

import { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import type { ToolCallOutcome } from "@/surfaces/api/devices/protocol";

export const DESKTOP_ACTIVITY_ACTIVE_MAX_AGE_MS = 15_000;
export const DESKTOP_ACTIVITY_IDLE_MIN_AGE_MS = 300_000;
export const DESKTOP_ACTIVITY_MAX_OBSERVATION_AGE_MS = 5_000;
export const DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS = 86_400_000;

const PS_TIMEOUT_MS = 10_000;

const RawDesktopActivitySchema = z.object({
  sessionLocked: z.boolean().nullable(),
  lastLocalInputAgeMs: z.number().int().nonnegative().nullable(),
  interactiveSessionCount: z.number().int().nonnegative().nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});
export type RawDesktopActivity = z.infer<typeof RawDesktopActivitySchema>;

export const DesktopActivitySchema = z.object({
  sessionLocked: z.boolean().nullable(),
  lastLocalInputAgeMs: z.number().int().nonnegative().nullable(),
  lastLocalInputAgeCapped: z.boolean(),
  interactiveSessionCount: z.number().int().nonnegative().nullable(),
  activity: z.enum(["active", "idle", "locked", "unknown"]),
  observedAt: z.iso.datetime({ offset: true }),
  observationAgeMs: z.number().int().nonnegative(),
  identityObserved: z.literal(false),
  uncertainty: z.string().nullable(),
});
export type DesktopActivity = z.infer<typeof DesktopActivitySchema>;

// Converts one ephemeral OS observation into the policy signal returned to the
// caller. Time is injected so freshness and threshold behavior stay testable.
export function classifyDesktopActivity(
  raw: RawDesktopActivity,
  nowMs: number,
): DesktopActivity {
  const observedAtMs = Date.parse(raw.observedAt);
  const observationAgeMs = Math.max(0, Math.round(nowMs - observedAtMs));
  const lastLocalInputAgeMs =
    raw.lastLocalInputAgeMs === null
      ? null
      : Math.min(raw.lastLocalInputAgeMs, DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS);
  const lastLocalInputAgeCapped =
    raw.lastLocalInputAgeMs !== null &&
    raw.lastLocalInputAgeMs > DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS;
  const base: Omit<DesktopActivity, "activity" | "uncertainty"> = {
    sessionLocked: raw.sessionLocked,
    lastLocalInputAgeMs,
    lastLocalInputAgeCapped,
    interactiveSessionCount: raw.interactiveSessionCount,
    observedAt: raw.observedAt,
    observationAgeMs,
    identityObserved: false,
  };

  if (observationAgeMs > DESKTOP_ACTIVITY_MAX_OBSERVATION_AGE_MS) {
    return {
      ...base,
      activity: "unknown",
      uncertainty: "the desktop activity observation is stale",
    };
  }
  if (raw.interactiveSessionCount === null) {
    return {
      ...base,
      activity: "unknown",
      uncertainty: "the interactive session count is unavailable",
    };
  }
  if (raw.interactiveSessionCount !== 1) {
    return {
      ...base,
      activity: "unknown",
      uncertainty: "multiple or no interactive user sessions were observed",
    };
  }
  if (raw.sessionLocked === null) {
    return {
      ...base,
      activity: "unknown",
      uncertainty: "the current session lock state is unavailable",
    };
  }
  if (raw.sessionLocked) {
    return { ...base, activity: "locked", uncertainty: null };
  }
  if (lastLocalInputAgeMs === null) {
    return {
      ...base,
      activity: "unknown",
      uncertainty: "the last local input time is unavailable",
    };
  }
  if (lastLocalInputAgeMs <= DESKTOP_ACTIVITY_ACTIVE_MAX_AGE_MS) {
    return { ...base, activity: "active", uncertainty: null };
  }
  if (lastLocalInputAgeMs >= DESKTOP_ACTIVITY_IDLE_MIN_AGE_MS) {
    return { ...base, activity: "idle", uncertainty: null };
  }
  return {
    ...base,
    activity: "unknown",
    uncertainty: "recent input is between the active and idle thresholds",
  };
}

export async function desktopActivity(
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  if (process.platform !== "win32") {
    return refused(
      `cannot observe desktop activity: this tool is only supported on Windows desktops (this desktop is ${process.platform})`,
    );
  }

  let raw: RawDesktopActivity;
  try {
    raw = await observeWindowsDesktopActivity(signal);
  } catch {
    if (signal?.aborted) return refused("cancelled");
    raw = {
      sessionLocked: null,
      lastLocalInputAgeMs: null,
      interactiveSessionCount: null,
      observedAt: new Date().toISOString(),
    };
  }
  if (signal?.aborted) return refused("cancelled");
  const activity = classifyDesktopActivity(raw, Date.now());
  const summary = activity.uncertainty
    ? `Desktop activity is unknown: ${activity.uncertainty}.`
    : `Desktop activity is ${activity.activity}.`;
  return {
    ok: true,
    content: [{ type: "text", text: summary }],
    structuredContent: activity,
  };
}

async function observeWindowsDesktopActivity(
  signal?: AbortSignal,
): Promise<RawDesktopActivity> {
  const result = await runPowerShell(ACTIVITY_SCRIPT, signal);
  if (result.error !== undefined) {
    throw new Error(result.error);
  }
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || `PowerShell exited with ${result.code}`,
    );
  }
  const line = result.stdout.trim();
  if (line.length === 0)
    throw new Error("activity observation produced no output");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("activity observation returned invalid JSON", {
      cause: error,
    });
  }
  const parsed = RawDesktopActivitySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("activity observation returned an unexpected shape");
  }
  return parsed.data;
}

type PowerShellResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
};

function runPowerShell(
  script: string,
  signal?: AbortSignal,
): Promise<PowerShellResult> {
  return new Promise((resolveRun) => {
    if (signal?.aborted) {
      resolveRun({ stdout: "", stderr: "", code: null, error: "cancelled" });
      return;
    }
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: PowerShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveRun(result);
    };
    const onAbort = (): void => {
      child.kill();
      finish({ stdout: "", stderr: "", code: null, error: "cancelled" });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        stdout: "",
        stderr: "",
        code: null,
        error: `timed out after ${PS_TIMEOUT_MS}ms`,
      });
    }, PS_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({
        stdout: "",
        stderr: "",
        code: null,
        error: errorMessage(error),
      });
    });
    child.on("close", (code) => {
      finish({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
  });
}

function refused(error: string): ToolCallOutcome {
  return { ok: false, content: [], error };
}

const ACTIVITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class SandiActivity {
  [StructLayout(LayoutKind.Sequential)]
  private struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WTS_SESSION_INFO {
    public int SessionId;
    public IntPtr WinStationName;
    public int State;
  }

  [DllImport("user32.dll")]
  private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

  [DllImport("kernel32.dll")]
  private static extern uint GetTickCount();

  [DllImport("wtsapi32.dll", SetLastError = true)]
  private static extern bool WTSQuerySessionInformation(
    IntPtr server,
    int sessionId,
    int infoClass,
    out IntPtr buffer,
    out int bytesReturned);

  [DllImport("wtsapi32.dll", SetLastError = true)]
  private static extern bool WTSEnumerateSessions(
    IntPtr server,
    int reserved,
    int version,
    out IntPtr sessions,
    out int count);

  [DllImport("wtsapi32.dll")]
  private static extern void WTSFreeMemory(IntPtr memory);

  public static uint? LastInputAgeMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return null;
    return unchecked(GetTickCount() - info.dwTime);
  }

  public static bool? SessionLocked() {
    IntPtr buffer;
    int bytes;
    int sessionId = Process.GetCurrentProcess().SessionId;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 25, out buffer, out bytes)) {
      return null;
    }
    try {
      int dataOffset = IntPtr.Size == 8 ? 8 : 4;
      int flagsOffset = dataOffset + 8;
      if (bytes < flagsOffset + 4 || Marshal.ReadInt32(buffer, 0) != 1) return null;
      int flags = Marshal.ReadInt32(buffer, flagsOffset);
      if (flags == 0) return true;
      if (flags == 1) return false;
      return null;
    } finally {
      WTSFreeMemory(buffer);
    }
  }

  public static int? InteractiveSessionCount() {
    IntPtr sessions;
    int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessions, out count)) {
      return null;
    }
    try {
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      int interactive = 0;
      for (int index = 0; index < count; index++) {
        IntPtr item = IntPtr.Add(sessions, index * size);
        WTS_SESSION_INFO session = (WTS_SESSION_INFO)Marshal.PtrToStructure(item, typeof(WTS_SESSION_INFO));
        IntPtr username;
        int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session.SessionId, 5, out username, out bytes)) {
          return null;
        }
        try {
          string name = Marshal.PtrToStringUni(username) ?? "";
          if (name.Length > 0) interactive++;
        } finally {
          WTSFreeMemory(username);
        }
      }
      return interactive;
    } finally {
      WTSFreeMemory(sessions);
    }
  }
}
"@

$payload = [ordered]@{
  sessionLocked = [SandiActivity]::SessionLocked()
  lastLocalInputAgeMs = [SandiActivity]::LastInputAgeMs()
  interactiveSessionCount = [SandiActivity]::InteractiveSessionCount()
  observedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
$payload | ConvertTo-Json -Compress
`;
