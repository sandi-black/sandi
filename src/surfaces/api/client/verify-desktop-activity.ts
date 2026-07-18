import { assert, assertEqual } from "@/lib/verification/harness";
import {
  classifyDesktopActivity,
  DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS,
  DESKTOP_ACTIVITY_MAX_OBSERVATION_AGE_MS,
  DesktopActivitySchema,
  desktopActivity,
  type RawDesktopActivity,
} from "@/surfaces/api/client/desktop-activity";

const NOW_MS = Date.parse("2026-07-18T12:00:00.000Z");

function raw(overrides: Partial<RawDesktopActivity>): RawDesktopActivity {
  return {
    sessionLocked: false,
    lastLocalInputAgeMs: 1_000,
    interactiveSessionCount: 1,
    observedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

function verifyClassification(): void {
  assertEqual(
    classifyDesktopActivity(raw({}), NOW_MS).activity,
    "active",
    "recent local input is active",
  );
  assertEqual(
    classifyDesktopActivity(raw({ lastLocalInputAgeMs: 600_000 }), NOW_MS)
      .activity,
    "idle",
    "old local input is idle",
  );
  assertEqual(
    classifyDesktopActivity(raw({ sessionLocked: true }), NOW_MS).activity,
    "locked",
    "a locked session is locked regardless of recent input",
  );

  const unavailable = classifyDesktopActivity(
    raw({
      sessionLocked: null,
      lastLocalInputAgeMs: null,
      interactiveSessionCount: null,
    }),
    NOW_MS,
  );
  assertEqual(
    unavailable.activity,
    "unknown",
    "unavailable OS observations are unknown",
  );
  assert(
    unavailable.uncertainty?.includes("unavailable") === true,
    "an unavailable observation explains its uncertainty",
  );

  const stale = classifyDesktopActivity(
    raw({
      observedAt: new Date(
        NOW_MS - DESKTOP_ACTIVITY_MAX_OBSERVATION_AGE_MS - 1,
      ).toISOString(),
    }),
    NOW_MS,
  );
  assertEqual(stale.activity, "unknown", "a stale observation is unknown");
  assert(
    stale.uncertainty?.includes("stale") === true,
    "a stale observation identifies freshness as the uncertainty",
  );

  const multipleSessions = classifyDesktopActivity(
    raw({ interactiveSessionCount: 2 }),
    NOW_MS,
  );
  assertEqual(
    multipleSessions.activity,
    "unknown",
    "multiple interactive sessions are ambiguous",
  );
  assertEqual(
    multipleSessions.interactiveSessionCount,
    2,
    "multi-session ambiguity remains explicit in the structured result",
  );
  assertEqual(
    classifyDesktopActivity(raw({ lastLocalInputAgeMs: 60_000 }), NOW_MS)
      .activity,
    "unknown",
    "the gap between active and idle thresholds is ambiguous",
  );
  const capped = classifyDesktopActivity(
    raw({ lastLocalInputAgeMs: DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS * 2 }),
    NOW_MS,
  );
  assertEqual(
    capped.lastLocalInputAgeMs,
    DESKTOP_ACTIVITY_MAX_INPUT_AGE_MS,
    "last-input age is capped before it crosses the tool boundary",
  );
  assert(capped.lastLocalInputAgeCapped, "the capped age is marked as bounded");
  console.log(
    "ok desktop activity classification covers active, idle, locked, unavailable, stale, and ambiguous observations",
  );
}

async function verifyToolBoundary(): Promise<void> {
  const result = await desktopActivity();
  if (process.platform !== "win32") {
    assert(!result.ok, "the Windows activity tool refuses off Windows");
    return;
  }
  assert(
    result.ok,
    `the activity tool returns a signal: ${result.error ?? ""}`,
  );
  const parsed = DesktopActivitySchema.safeParse(result.structuredContent);
  assert(parsed.success, "the activity tool returns structured activity data");
  if (parsed.success) {
    assertEqual(
      parsed.data.identityObserved,
      false,
      "the activity signal explicitly excludes identity",
    );
    assert(
      parsed.data.observationAgeMs <= DESKTOP_ACTIVITY_MAX_OBSERVATION_AGE_MS,
      "the live observation is fresh",
    );
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = await desktopActivity(controller.signal);
  assert(
    !cancelled.ok && cancelled.error === "cancelled",
    "an aborted activity observation refuses as cancelled",
  );
  console.log("ok the desktop activity tool returns a fresh structured signal");
}

verifyClassification();
await verifyToolBoundary();
console.log("desktop activity verification passed");
