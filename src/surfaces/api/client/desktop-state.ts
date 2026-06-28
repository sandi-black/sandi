import { spawn } from "node:child_process";

import { z } from "zod/v4";
import type {
  LocalScreenshotParams,
  ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";

// The Windows side of the desktop state tools: enumerate the monitors and open
// windows of this machine and capture a screenshot of a monitor or a window.
// These read the shape of the desktop rather than its files, so they live apart
// from the file and shell executors. Everything is done through Windows
// PowerShell and .NET (System.Windows.Forms for the screen list, user32 for the
// window list, System.Drawing for the capture), so there is no native module to
// build or ship: the same trust model as the shell tool, which already runs
// arbitrary commands on the paired desktop.
//
// Only Windows is supported today. On any other platform the tools refuse with a
// clear message rather than guess at a cross-platform capture path.

const DEFAULT_MAX_DIMENSION = 1568;
const MIN_MAX_DIMENSION = 256;
const MAX_MAX_DIMENSION = 4096;
const JPEG_QUALITY = 82;
const SCREENSHOT_MIME = "image/jpeg";
const PS_TIMEOUT_MS = 30_000;
// A busy desktop can have many windows; cap the listing so one call cannot flood
// the model, and note when the list was trimmed.
const MAX_WINDOWS = 300;

type Rect = { x: number; y: number; width: number; height: number };

const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const MonitorSchema = z.object({
  index: z.number().int().nonnegative(),
  deviceName: z.string(),
  primary: z.boolean(),
  bounds: RectSchema,
  workingArea: RectSchema,
});
type Monitor = z.infer<typeof MonitorSchema>;

const WindowSchema = z.object({
  handle: z.string(),
  title: z.string(),
  processName: z.string(),
  pid: z.number().int().nonnegative(),
  minimized: z.boolean(),
  bounds: RectSchema,
});
type DesktopWindow = z.infer<typeof WindowSchema>;

const CaptureSchema = z.object({
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  base64: z.string().min(1),
});
type Capture = z.infer<typeof CaptureSchema>;

// Lists the monitors attached to this desktop with their pixel bounds, so Sandi
// can pick one to screenshot by index or device name.
export async function listMonitors(
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const unsupported = ensureWindows("list monitors");
  if (unsupported) return unsupported;
  try {
    const monitors = await enumerateMonitors(signal);
    if (monitors.length === 0) return ok("No monitors were detected.");
    const lines = monitors.map((monitor) => {
      const primary = monitor.primary ? "  primary" : "";
      const b = monitor.bounds;
      return `- [${monitor.index}] ${monitor.deviceName}${primary}  ${b.width}x${b.height} at (${b.x},${b.y})`;
    });
    return ok([`Monitors (${monitors.length}):`, ...lines].join("\n"));
  } catch (error) {
    return refused(errorMessage(error));
  }
}

// Lists the visible top-level windows on this desktop (those with a title bar),
// so Sandi can pick one to screenshot by handle or title.
export async function listWindows(
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const unsupported = ensureWindows("list windows");
  if (unsupported) return unsupported;
  try {
    const windows = await enumerateWindows(signal);
    if (windows.length === 0) return ok("No visible windows were found.");
    const shown = windows.slice(0, MAX_WINDOWS);
    const lines = shown.map((win) => {
      const b = win.bounds;
      const minimized = win.minimized ? " [minimized]" : "";
      return `- ${JSON.stringify(win.title)}  ${win.processName} (pid ${win.pid})  ${b.width}x${b.height} at (${b.x},${b.y})  handle ${win.handle}${minimized}`;
    });
    const note =
      windows.length > shown.length
        ? `\n(${windows.length - shown.length} more windows omitted)`
        : "";
    return ok(
      `${[`Open windows (${windows.length}):`, ...lines].join("\n")}${note}`,
    );
  } catch (error) {
    return refused(errorMessage(error));
  }
}

// Captures a screenshot of one monitor or one window and returns it as a
// downscaled JPEG. With neither selector the primary monitor is captured.
export async function screenshot(
  params: LocalScreenshotParams,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  const unsupported = ensureWindows("take a screenshot");
  if (unsupported) return unsupported;
  if (params.monitor !== undefined && params.window !== undefined) {
    return refused("specify either a monitor or a window to capture, not both");
  }
  const maxDimension = clamp(
    params.maxDimension ?? DEFAULT_MAX_DIMENSION,
    MIN_MAX_DIMENSION,
    MAX_MAX_DIMENSION,
  );
  try {
    if (params.window !== undefined) {
      return await screenshotWindow(params.window, maxDimension, signal);
    }
    return await screenshotMonitor(params.monitor, maxDimension, signal);
  } catch (error) {
    return refused(errorMessage(error));
  }
}

async function screenshotMonitor(
  selector: string | undefined,
  maxDimension: number,
  signal: AbortSignal | undefined,
): Promise<ToolCallOutcome> {
  const monitors = await enumerateMonitors(signal);
  if (monitors.length === 0) return refused("no monitors were detected");
  const target =
    selector !== undefined
      ? resolveMonitor(monitors, selector)
      : (monitors.find((monitor) => monitor.primary) ?? monitors[0]);
  if (!target) {
    const available = monitors
      .map((monitor) => `[${monitor.index}] ${monitor.deviceName}`)
      .join(", ");
    return refused(
      `no monitor matches "${selector}"; available monitors: ${available}`,
    );
  }
  const capture = await captureRegion(target.bounds, maxDimension, signal);
  const summary =
    `Captured monitor [${target.index}] ${target.deviceName} ` +
    `(${capture.originalWidth}x${capture.originalHeight}), ` +
    `scaled to ${capture.width}x${capture.height}, ${describeSize(capture.base64)}.`;
  return okImage(summary, capture.base64);
}

async function screenshotWindow(
  selector: string,
  maxDimension: number,
  signal: AbortSignal | undefined,
): Promise<ToolCallOutcome> {
  const windows = await enumerateWindows(signal);
  const target = resolveWindow(windows, selector);
  if (!target) {
    const sample = windows
      .slice(0, 10)
      .map((win) => JSON.stringify(win.title))
      .join(", ");
    const hint = sample.length > 0 ? `; some open windows: ${sample}` : "";
    return refused(`no window matches "${selector}"${hint}`);
  }
  if (target.minimized) {
    return refused(
      `window ${JSON.stringify(target.title)} is minimized; restore it before capturing`,
    );
  }
  const capture = await captureWindow(target.handle, maxDimension, signal);
  const summary =
    `Captured window ${JSON.stringify(target.title)} ` +
    `(${target.processName}, pid ${target.pid}) ` +
    `(${capture.originalWidth}x${capture.originalHeight}), ` +
    `scaled to ${capture.width}x${capture.height}, ${describeSize(capture.base64)}.`;
  return okImage(summary, capture.base64);
}

// Resolves a monitor selector: a numeric index, or a device name (with or
// without the `\\.\` prefix), case-insensitive.
function resolveMonitor(
  monitors: Monitor[],
  selector: string,
): Monitor | undefined {
  const norm = selector.trim().toLowerCase();
  const byIndex = monitors.find((monitor) => String(monitor.index) === norm);
  if (byIndex) return byIndex;
  return monitors.find((monitor) => {
    const name = monitor.deviceName.toLowerCase();
    return (
      name === norm || name.endsWith(`\\${norm}`) || name === `\\\\.\\${norm}`
    );
  });
}

// Resolves a window selector: an exact handle, then an exact title, then a
// unique case-insensitive title substring. An ambiguous substring resolves to
// nothing so the caller is asked to be more specific rather than capturing an
// arbitrary window.
function resolveWindow(
  windows: DesktopWindow[],
  selector: string,
): DesktopWindow | undefined {
  const byHandle = windows.find((win) => win.handle === selector.trim());
  if (byHandle) return byHandle;
  const norm = selector.trim().toLowerCase();
  const exactTitle = windows.filter((win) => win.title.toLowerCase() === norm);
  const [onlyExact] = exactTitle;
  if (onlyExact && exactTitle.length === 1) return onlyExact;
  const substring = windows.filter((win) =>
    win.title.toLowerCase().includes(norm),
  );
  const [onlySubstring] = substring;
  if (onlySubstring && substring.length === 1) return onlySubstring;
  return undefined;
}

async function enumerateMonitors(signal?: AbortSignal): Promise<Monitor[]> {
  const result = await runPowerShell(MONITORS_SCRIPT, signal);
  ensureExited(result, "list monitors");
  return parseJsonLines(result.stdout, MonitorSchema);
}

async function enumerateWindows(
  signal?: AbortSignal,
): Promise<DesktopWindow[]> {
  const result = await runPowerShell(WINDOWS_SCRIPT, signal);
  ensureExited(result, "list windows");
  return parseJsonLines(result.stdout, WindowSchema);
}

async function captureRegion(
  rect: Rect,
  maxDimension: number,
  signal?: AbortSignal,
): Promise<Capture> {
  const result = await runPowerShell(
    captureRegionScript(rect, maxDimension),
    signal,
  );
  ensureExited(result, "capture the screen");
  return parseCapture(result.stdout);
}

async function captureWindow(
  handle: string,
  maxDimension: number,
  signal?: AbortSignal,
): Promise<Capture> {
  if (!/^\d+$/.test(handle)) {
    throw new Error(`malformed window handle: ${handle}`);
  }
  const result = await runPowerShell(
    captureWindowScript(handle, maxDimension),
    signal,
  );
  ensureExited(result, "capture the window");
  return parseCapture(result.stdout);
}

// Shared PowerShell tail: takes a $bmp and $maxDim already in scope, downscales
// so the longest edge is at most $maxDim, encodes JPEG, and prints one JSON
// object with the original and scaled dimensions plus the base64 bytes.
const ENCODE_TAIL = `
$ow = $bmp.Width
$oh = $bmp.Height
$maxSide = [Math]::Max($ow, $oh)
$scale = 1.0
if ($maxSide -gt $maxDim) { $scale = $maxDim / $maxSide }
$nw = [Math]::Max(1, [int][Math]::Round($ow * $scale))
$nh = [Math]::Max(1, [int][Math]::Round($oh * $scale))
$out = New-Object System.Drawing.Bitmap($nw, $nh)
$g3 = [System.Drawing.Graphics]::FromImage($out)
$g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g3.DrawImage($bmp, 0, 0, $nw, $nh)
$g3.Dispose()
$ms = New-Object System.IO.MemoryStream
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]${JPEG_QUALITY})
$out.Save($ms, $enc, $ep)
$bytes = $ms.ToArray()
$ms.Dispose()
$out.Dispose()
$bmp.Dispose()
$payload = [pscustomobject]@{ originalWidth = $ow; originalHeight = $oh; width = $nw; height = $nh; base64 = [Convert]::ToBase64String($bytes) }
$payload | ConvertTo-Json -Compress -Depth 3
`;

const MONITORS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
for ($i = 0; $i -lt $screens.Count; $i++) {
  $s = $screens[$i]
  $b = $s.Bounds
  $w = $s.WorkingArea
  $obj = [pscustomobject]@{
    index = $i
    deviceName = $s.DeviceName
    primary = [bool]$s.Primary
    bounds = [pscustomobject]@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
    workingArea = [pscustomobject]@{ x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height }
  }
  $obj | ConvertTo-Json -Compress -Depth 4
}
`;

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SandiWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$rows = New-Object System.Collections.Generic.List[string]
$cb = [SandiWin+EnumProc] {
  param($hWnd, $lParam)
  if ([SandiWin]::IsWindowVisible($hWnd)) {
    $len = [SandiWin]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [void][SandiWin]::GetWindowText($hWnd, $sb, $sb.Capacity)
      $rect = New-Object SandiWin+RECT
      [void][SandiWin]::GetWindowRect($hWnd, [ref]$rect)
      $procId = [uint32]0
      [void][SandiWin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      $procName = ''
      try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = '' }
      $obj = [pscustomobject]@{
        handle = $hWnd.ToString()
        title = $sb.ToString()
        processName = $procName
        pid = [int]$procId
        minimized = [bool]([SandiWin]::IsIconic($hWnd))
        bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
      }
      $rows.Add(($obj | ConvertTo-Json -Compress -Depth 4))
    }
  }
  return $true
}
[void][SandiWin]::EnumWindows($cb, [IntPtr]::Zero)
$rows | ForEach-Object { $_ }
`;

function captureRegionScript(rect: Rect, maxDim: number): string {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$maxDim = ${maxDim}
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${width}, ${height})))
$g.Dispose()
${ENCODE_TAIL}`;
}

function captureWindowScript(handle: string, maxDim: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SandiCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$maxDim = ${maxDim}
$hWnd = [IntPtr]${handle}
$rect = New-Object SandiCap+RECT
[void][SandiCap]::GetWindowRect($hWnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw 'window has no visible area to capture' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [SandiCap]::PrintWindow($hWnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) {
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g2.Dispose()
}
${ENCODE_TAIL}`;
}

type PsResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
};

// Runs a PowerShell script and resolves with its output. The script is passed
// base64-encoded (UTF-16LE, what -EncodedCommand expects) so no quoting or shell
// metacharacters can mangle it. Never rejects: a spawn failure, a timeout, or a
// cancel resolve with `error` set, which the caller turns into a refused outcome.
function runPowerShell(
  script: string,
  signal?: AbortSignal,
): Promise<PsResult> {
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
    const finish = (result: PsResult): void => {
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
        error: error instanceof Error ? error.message : String(error),
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

function ensureExited(result: PsResult, action: string): void {
  if (result.error !== undefined) {
    throw new Error(`could not ${action}: ${result.error}`);
  }
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || `PowerShell exited with ${result.code}`;
    throw new Error(`could not ${action}: ${detail}`);
  }
}

// Parses newline-delimited JSON, keeping only the lines that match the schema.
// PowerShell emits one compact JSON object per item, so a stray line (a warning,
// a blank) is skipped rather than failing the whole listing.
function parseJsonLines<T>(stdout: string, schema: z.ZodType<T>): T[] {
  const items: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

function parseCapture(stdout: string): Capture {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error("capture produced no output");
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    throw new Error("capture returned output that was not valid JSON");
  }
  const parsed = CaptureSchema.safeParse(raw);
  if (!parsed.success) throw new Error("capture returned a malformed image");
  return parsed.data;
}

// Only Windows is supported. Returns a refused outcome to use directly when this
// is some other platform, or undefined to proceed.
function ensureWindows(action: string): ToolCallOutcome | undefined {
  if (process.platform === "win32") return undefined;
  return refused(
    `cannot ${action}: the desktop state tools are only supported on Windows desktops (this desktop is ${process.platform})`,
  );
}

// Approximate decoded byte size of a base64 string, for the human-readable
// summary that rides with a screenshot.
function describeSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `JPEG ~${Math.round(kib)} KB`;
  return `JPEG ~${(kib / 1024).toFixed(1)} MB`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ok(output: string): ToolCallOutcome {
  return { ok: true, output };
}

function okImage(output: string, dataBase64: string): ToolCallOutcome {
  return {
    ok: true,
    output,
    image: { mimeType: SCREENSHOT_MIME, dataBase64 },
  };
}

function refused(error: string): ToolCallOutcome {
  return { ok: false, output: "", error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
