import { assert } from "@/lib/verification/harness";
import {
  isFreshVisualObservation,
  VisualObservationEnvelopeSchema,
  VisualObservationSchema,
} from "@/surfaces/api/client/visual-observation";

export function verifyVisualObservationBoundary(): void {
  const at96Dpi = {
    version: 2,
    capturedAtMs: 1_700_000_000_000,
    target: { hwnd: "101", pid: 202 },
    active: true,
    clientRect: { x: 0, y: 0, width: 800, height: 600 },
    clientOriginScreen: { x: 120, y: 160 },
    dpi: 96,
    screenshot: { width: 800, height: 600, scaleX: 1, scaleY: 1 },
  };
  assert(
    VisualObservationSchema.safeParse(at96Dpi).success,
    "a 96 DPI client observation is accepted",
  );
  assert(
    isFreshVisualObservation(
      VisualObservationSchema.parse(at96Dpi),
      at96Dpi.capturedAtMs + 10_000,
    ),
    "a version 2 observation remains fresh through its ten-second boundary",
  );
  assert(
    !isFreshVisualObservation(
      VisualObservationSchema.parse(at96Dpi),
      at96Dpi.capturedAtMs + 10_001,
    ),
    "a version 2 observation expires after ten seconds",
  );
  assert(
    !VisualObservationSchema.safeParse({ ...at96Dpi, version: 1 }).success,
    "the observation boundary rejects the superseded version 1 shape",
  );
  assert(
    !VisualObservationSchema.safeParse({
      ...at96Dpi,
      target: { ...at96Dpi.target, hwnd: "0" },
    }).success,
    "the observation boundary rejects the null HWND",
  );

  const mixedDpi = {
    version: 2,
    capturedAtMs: 1_700_000_000_100,
    target: { hwnd: "303", pid: 404 },
    active: true,
    clientRect: { x: 0, y: 0, width: 1280, height: 720 },
    clientOriginScreen: { x: -1280, y: 40 },
    dpi: 144,
    screenshot: {
      width: 640,
      height: 360,
      scaleX: 0.5,
      scaleY: 0.5,
    },
  };
  assert(
    VisualObservationEnvelopeSchema.safeParse({
      visualObservation: mixedDpi,
    }).success,
    "a downscaled mixed-DPI observation is accepted",
  );

  assert(
    !VisualObservationSchema.safeParse({
      ...mixedDpi,
      clientRect: { ...mixedDpi.clientRect, x: 10 },
    }).success,
    "an absolute client rectangle is rejected",
  );
  assert(
    !VisualObservationSchema.safeParse({
      ...mixedDpi,
      screenshot: { ...mixedDpi.screenshot, scaleX: 0.75 },
    }).success,
    "an inconsistent screenshot scale is rejected",
  );
  assert(
    !VisualObservationSchema.safeParse({
      ...mixedDpi,
      screenshot: {
        width: 1600,
        height: 900,
        scaleX: 1.25,
        scaleY: 1.25,
      },
    }).success,
    "an upscaled screenshot observation is rejected",
  );
  console.log("ok visual observation contract covers 96 and mixed DPI");
}
