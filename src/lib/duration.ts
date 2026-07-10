export type DurationRounding = "floor" | "round";

export type DurationFormatOptions =
  | { granularity: "seconds" }
  | { granularity: "minutes"; rounding?: DurationRounding };

/**
 * Renders a millisecond duration for a status line or log line. Two
 * granularities cover every caller's convention:
 *
 *  - "seconds": every unit down to the second ("Nd Nh Nm Ns"), used where the
 *    breakdown itself is the point (process uptime).
 *  - "minutes": the coarsest two applicable units ("Nd Nh", "Nh Nm", or
 *    "Nm"), used for a human-scale estimate (a countdown, a rate-limit reset).
 *    `rounding` controls how the millisecond value collapses to whole
 *    minutes: "floor" (the default) rounds to the nearest second first, then
 *    truncates to minutes, for a caller whose input is already a whole-second
 *    budget; "round" rounds the millisecond value straight to the nearest
 *    minute, for a live countdown where rounding reads more naturally than
 *    truncating.
 */
export function formatDuration(
  durationMs: number,
  options: DurationFormatOptions,
): string {
  if (options.granularity === "seconds") {
    return formatSecondsBreakdown(durationMs);
  }
  return formatMinutesBreakdown(durationMs, options.rounding ?? "floor");
}

function formatSecondsBreakdown(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatMinutesBreakdown(
  durationMs: number,
  rounding: DurationRounding,
): string {
  const totalMinutes = Math.max(
    0,
    rounding === "round"
      ? Math.round(durationMs / 60_000)
      : // Round to the nearest whole second first (a no-op for a caller whose
        // input was already whole seconds converted to ms), then truncate to
        // minutes, matching a caller that historically worked in seconds.
        Math.floor(Math.round(durationMs / 1_000) / 60),
  );
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
