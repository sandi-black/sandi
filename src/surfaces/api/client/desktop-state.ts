import { spawn } from "node:child_process";

import { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import { VisualObservationSchema } from "@/surfaces/api/client/visual-observation";
import {
  imageBytesMatchMime,
  isCanonicalBase64,
  type LocalScreenshotParams,
  type ToolCallOutcome,
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
// clear message.

const DEFAULT_MAX_DIMENSION = 1568;
const MIN_MAX_DIMENSION = 256;
// Kept well below 4K: a JPEG at this longest edge stays comfortably under the
// device-result body cap, and the model gains little from more pixels.
const MAX_MAX_DIMENSION = 2048;
const JPEG_QUALITY = 82;
const SCREENSHOT_MIME = "image/jpeg";
const PS_TIMEOUT_MS = 30_000;
// The device-result POST is capped at 8 MiB of JSON (DEVICE_RESULT_MAX_BODY_BYTES
// in device-routes). The base64 image is the bulk of that body, so cap it below
// the limit with headroom for the JSON envelope. A capture that still exceeds it
// is refused promptly (a small text result) rather than POSTed and rejected with
// a 413 that would leave the call pending until the broker backstop fires.
const MAX_IMAGE_BASE64_BYTES = 6 * 1024 * 1024;
// A busy desktop can have many windows; cap the listing so one call cannot flood
// the model, and note when the list was trimmed.
const MAX_WINDOWS = 300;

type Rect = { x: number; y: number; width: number; height: number };

// A pixel rectangle from the enumeration subprocess: integer coordinates (which
// may be negative on a multi-monitor desktop) and positive integer dimensions.
// Parsed precisely so malformed bounds cannot ride into a capture region.
const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
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
  // A window handle is a decimal IntPtr string; parse it as such here so an
  // invalid handle is rejected at the boundary, not re-checked ad hoc later.
  handle: z.string().regex(/^\d+$/, "must be a decimal window handle"),
  title: z.string(),
  processName: z.string(),
  pid: z.number().int().nonnegative(),
  minimized: z.boolean(),
  bounds: RectSchema,
});
type DesktopWindow = z.infer<typeof WindowSchema>;

const WindowWarningSchema = z.object({
  handle: z.string().regex(/^\d+$/u).optional(),
  operation: z.enum([
    "GetWindowText",
    "GetWindowRect",
    "GetWindowThreadProcessId",
    "result-limit",
  ]),
  message: z.string().min(1),
});

const WindowEnumerationLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("window"), window: WindowSchema }),
  z.object({ kind: z.literal("warning"), warning: WindowWarningSchema }),
]);

export const WindowEnumerationResultSchema = z.object({
  windows: z.array(WindowSchema),
  warnings: z.array(WindowWarningSchema),
  complete: z.boolean(),
});
export type WindowEnumerationResult = z.infer<
  typeof WindowEnumerationResultSchema
>;

export type WindowEnumerationCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
};

// The capture subprocess is a trust boundary like any other: its stdout is
// parsed precisely, including that the payload is canonical base64 whose decoded
// bytes are a JPEG, so a mangled capture fails closed here rather than
// travelling on as a typed image.
const CaptureSchema = z
  .object({
    originalWidth: z.number().int().positive(),
    originalHeight: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    base64: z.string().refine(isCanonicalBase64, "must be canonical base64"),
  })
  .refine((capture) => imageBytesMatchMime("image/jpeg", capture.base64), {
    message: "capture was not a JPEG image",
    path: ["base64"],
  });
type Capture = z.infer<typeof CaptureSchema>;

const WindowCaptureSchema = z
  .object({
    originalWidth: z.number().int().positive(),
    originalHeight: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    base64: z.string().refine(isCanonicalBase64, "must be canonical base64"),
    visualObservation: VisualObservationSchema,
  })
  .refine((capture) => imageBytesMatchMime("image/jpeg", capture.base64), {
    message: "capture was not a JPEG image",
    path: ["base64"],
  });
type WindowCapture = z.infer<typeof WindowCaptureSchema>;

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
    const enumeration = await enumerateWindows(signal);
    const windows = enumeration.windows.slice(0, MAX_WINDOWS);
    const omitted = enumeration.windows.length - windows.length;
    const limitWarning: z.infer<typeof WindowWarningSchema> | undefined =
      omitted > 0
        ? {
            operation: "result-limit",
            message: `${omitted} additional windows were omitted`,
          }
        : undefined;
    const warnings = limitWarning
      ? [...enumeration.warnings, limitWarning]
      : enumeration.warnings;
    const result: WindowEnumerationResult = {
      windows,
      warnings,
      complete: enumeration.complete && omitted === 0,
    };
    return ok(JSON.stringify(result, null, 2));
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
  const tooLarge = imageTooLarge(capture.base64);
  if (tooLarge) return refused(tooLarge);
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
  const enumeration = await enumerateWindows(signal);
  const target = resolveWindow(enumeration.windows, selector);
  if (!target) {
    const sample = enumeration.windows
      .slice(0, 10)
      .map((win) => JSON.stringify(win.title))
      .join(", ");
    const hint = sample.length > 0 ? `; some open windows: ${sample}` : "";
    const incomplete = enumeration.complete
      ? ""
      : `; window enumeration was incomplete (${enumeration.warnings.length} warning(s)), so absence is not definitive`;
    return refused(`no window matches "${selector}"${hint}${incomplete}`);
  }
  if (target.minimized) {
    return refused(
      `window ${JSON.stringify(target.title)} is minimized; restore it before capturing`,
    );
  }
  const capture = await captureWindow(
    target.handle,
    target.pid,
    maxDimension,
    signal,
  );
  const tooLarge = imageTooLarge(capture.base64);
  if (tooLarge) return refused(tooLarge);
  const summary =
    `Captured window client ${JSON.stringify(target.title)} ` +
    `(${target.processName}, pid ${target.pid}) ` +
    `(${capture.originalWidth}x${capture.originalHeight}), ` +
    `scaled to ${capture.width}x${capture.height}, ${describeSize(capture.base64)}.`;
  return okImage(summary, capture.base64, {
    visualObservation: capture.visualObservation,
  });
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
  return parseJsonLines(result.stdout, MonitorSchema, "the monitor list");
}

async function enumerateWindows(
  signal?: AbortSignal,
): Promise<WindowEnumerationResult> {
  const result = await runPowerShell(WINDOWS_SCRIPT, signal);
  return readWindowEnumeration(result);
}

export function readWindowEnumeration(
  result: WindowEnumerationCommandResult,
): WindowEnumerationResult {
  ensureExited(result, "list windows");
  const lines = parseJsonLines(
    result.stdout,
    WindowEnumerationLineSchema,
    "the window list",
  );
  const windows: DesktopWindow[] = [];
  const warnings: z.infer<typeof WindowWarningSchema>[] = [];
  for (const line of lines) {
    if (line.kind === "window") windows.push(line.window);
    else warnings.push(line.warning);
  }
  return { windows, warnings, complete: warnings.length === 0 };
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
  // The handle is a decimal IntPtr string already parsed by WindowSchema, so it
  // is safe to interpolate into the capture script. The script still revalidates
  // the HWND/PID pair before and after capture because identity is the safety boundary.
  handle: string,
  pid: number,
  maxDimension: number,
  signal?: AbortSignal,
): Promise<WindowCapture> {
  const result = await runPowerShell(
    captureWindowScript(handle, pid, maxDimension),
    signal,
  );
  ensureExited(result, "capture the window");
  return parseWindowCapture(result.stdout);
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
if ($null -ne $visualObservationBase) {
  $visualObservationBase | Add-Member -NotePropertyName screenshot -NotePropertyValue ([pscustomobject]@{
    width = $nw
    height = $nh
    scaleX = $nw / $visualObservationBase.clientRect.width
    scaleY = $nh / $visualObservationBase.clientRect.height
  })
  $payload | Add-Member -NotePropertyName visualObservation -NotePropertyValue $visualObservationBase
}
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
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
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
# Best-effort process-name table. A window whose owning process this session
# cannot read (elevated, or exited mid-scan) simply lists with an empty
# processName; the window is still real. This is the one supplementary field,
# distinct from the required title, bounds, and pid checked below.
$procNames = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue) { $procNames[[int]$p.Id] = $p.ProcessName }
$cb = [SandiWin+EnumProc] {
  param($hWnd, $lParam)
  if (-not [SandiWin]::IsWindowVisible($hWnd)) { return $true }
  $len = [SandiWin]::GetWindowTextLength($hWnd)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  $copied = [SandiWin]::GetWindowText($hWnd, $sb, $sb.Capacity)
  if ($copied -le 0) {
    $warning = [pscustomobject]@{ kind = 'warning'; warning = [pscustomobject]@{ handle = $hWnd.ToString(); operation = 'GetWindowText'; message = 'window disappeared or became inaccessible' } }
    [void]$rows.Add(($warning | ConvertTo-Json -Compress -Depth 4))
    return $true
  }
  $rect = New-Object SandiWin+RECT
  if (-not [SandiWin]::GetWindowRect($hWnd, [ref]$rect)) {
    $warning = [pscustomobject]@{ kind = 'warning'; warning = [pscustomobject]@{ handle = $hWnd.ToString(); operation = 'GetWindowRect'; message = 'window disappeared or became inaccessible' } }
    [void]$rows.Add(($warning | ConvertTo-Json -Compress -Depth 4))
    return $true
  }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  # A visible titled window with no area is a helper window, not something to
  # list or capture; skip it (this is a filter, not a discarded failure).
  if ($w -le 0 -or $h -le 0) { return $true }
  $procId = [uint32]0
  $tid = [SandiWin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if ($tid -eq 0) {
    $warning = [pscustomobject]@{ kind = 'warning'; warning = [pscustomobject]@{ handle = $hWnd.ToString(); operation = 'GetWindowThreadProcessId'; message = 'window disappeared or became inaccessible' } }
    [void]$rows.Add(($warning | ConvertTo-Json -Compress -Depth 4))
    return $true
  }
  $procName = ''
  if ($procNames.ContainsKey([int]$procId)) { $procName = $procNames[[int]$procId] }
  # Windows PowerShell 5.1's ConvertTo-Json leaves C0 control characters raw,
  # producing invalid JSON. They have no display value in a window title, so
  # replace them at the subprocess boundary while preserving the rest.
  $replacement = [string]([char]0xFFFD)
  $title = [regex]::Replace($sb.ToString(), '[\\x00-\\x1F]', $replacement)
  $obj = [pscustomobject]@{
    handle = $hWnd.ToString()
    title = $title
    processName = $procName
    pid = [int]$procId
    minimized = [bool]([SandiWin]::IsIconic($hWnd))
    bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $w; height = $h }
  }
  $entry = [pscustomobject]@{ kind = 'window'; window = $obj }
  [void]$rows.Add(($entry | ConvertTo-Json -Compress -Depth 5))
  return $true
}
$ok = [SandiWin]::EnumWindows($cb, [IntPtr]::Zero)
if (-not $ok) { throw 'EnumWindows failed' }
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

function captureWindowScript(
  handle: string,
  pid: number,
  maxDim: number,
): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SandiCap {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@
$maxDim = ${maxDim}
$target = [IntPtr]${handle}
$priorDpiContext = [SandiCap]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if ($priorDpiContext -eq [IntPtr]::Zero) { throw 'SetThreadDpiAwarenessContext failed' }
function Read-Geometry {
  if (-not [SandiCap]::IsWindow($target)) { throw 'window no longer exists' }
  $actualPid = [uint32]0
  if ([SandiCap]::GetWindowThreadProcessId($target, [ref]$actualPid) -eq 0) { throw 'GetWindowThreadProcessId failed' }
  if ($actualPid -ne [uint32]${pid}) { throw 'window process changed' }
  $rect = New-Object SandiCap+RECT
  if (-not [SandiCap]::GetClientRect($target, [ref]$rect)) { throw 'GetClientRect failed' }
  $origin = New-Object SandiCap+POINT
  $origin.X = $rect.Left
  $origin.Y = $rect.Top
  if (-not [SandiCap]::ClientToScreen($target, [ref]$origin)) { throw 'ClientToScreen failed' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $dpi = [SandiCap]::GetDpiForWindow($target)
  if ($width -le 0 -or $height -le 0 -or $dpi -eq 0) { throw 'window client geometry is unavailable' }
  [pscustomobject]@{
    pid = [int]$actualPid
    active = [SandiCap]::GetForegroundWindow() -eq $target
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
    originX = $origin.X
    originY = $origin.Y
    dpi = [int]$dpi
  }
}
$before = Read-Geometry
$bmp = New-Object System.Drawing.Bitmap($before.width, $before.height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($before.originX, $before.originY, 0, 0, (New-Object System.Drawing.Size($before.width, $before.height)))
$graphics.Dispose()
$after = Read-Geometry
if ($before.pid -ne $after.pid -or $before.active -ne $after.active -or
    $before.x -ne $after.x -or $before.y -ne $after.y -or
    $before.width -ne $after.width -or $before.height -ne $after.height -or
    $before.originX -ne $after.originX -or $before.originY -ne $after.originY -or
    $before.dpi -ne $after.dpi) {
  $bmp.Dispose()
  throw 'window changed during client capture'
}
$null = [SandiCap]::SetThreadDpiAwarenessContext($priorDpiContext)
$visualObservationBase = [pscustomobject]@{
  version = 2
  capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  target = [pscustomobject]@{ hwnd = '${handle}'; pid = $before.pid }
  active = $before.active
  clientRect = [pscustomobject]@{ x = $before.x; y = $before.y; width = $before.width; height = $before.height }
  clientOriginScreen = [pscustomobject]@{ x = $before.originX; y = $before.originY }
  dpi = $before.dpi
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

// Parses newline-delimited JSON, one record per non-blank line. PowerShell emits
// one compact JSON object per item to stdout and nothing else, so a non-blank
// line that does not parse or does not match the schema is corrupt output, not
// noise to skip: it throws so the listing fails closed rather than quietly
// returning partial or empty data. Blank lines (trailing newline) are ignored.
function parseJsonLines<T>(
  stdout: string,
  schema: z.ZodType<T>,
  label: string,
): T[] {
  const items: T[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new Error(`${label} returned a line that was not valid JSON`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${label} returned an unexpected record shape`);
    }
    items.push(parsed.data);
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

function parseWindowCapture(stdout: string): WindowCapture {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error("window capture produced no output");
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    throw new Error("window capture returned output that was not valid JSON");
  }
  const parsed = WindowCaptureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("window capture returned a malformed visual observation");
  }
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

// Refuses a capture whose encoded size would not fit the device-result body cap.
// Returns the refusal message, or undefined when the image is within budget.
function imageTooLarge(base64: string): string | undefined {
  if (base64.length <= MAX_IMAGE_BASE64_BYTES) return undefined;
  const mb = (base64.length / (1024 * 1024)).toFixed(1);
  return `the screenshot is too large to return (${mb} MB encoded); retry with a smaller maxDimension`;
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
  return { ok: true, content: [{ type: "text", text: output }] };
}

function okImage(
  output: string,
  dataBase64: string,
  structuredContent?: Record<string, unknown>,
): ToolCallOutcome {
  return {
    ok: true,
    content: [
      { type: "text", text: output },
      { type: "image", mimeType: SCREENSHOT_MIME, dataBase64 },
    ],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function refused(error: string): ToolCallOutcome {
  return { ok: false, content: [], error };
}
