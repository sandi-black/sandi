import { z } from "zod/v4";

const PointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

const ClientRectSchema = PointSchema.extend({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const ScreenshotGeometrySchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleX: z.number().positive().max(1),
  scaleY: z.number().positive().max(1),
});

// Window screenshots and guarded visual actions share this observation shape.
export const VisualObservationSchema = z
  .object({
    version: z.literal(1),
    target: z.object({
      hwnd: z.string().regex(/^\d+$/, "must be a decimal window handle"),
      pid: z.number().int().positive(),
    }),
    active: z.boolean(),
    clientRect: ClientRectSchema,
    clientOriginScreen: PointSchema,
    dpi: z.number().int().min(48).max(768),
    screenshot: ScreenshotGeometrySchema,
  })
  .superRefine((observation, context) => {
    if (observation.clientRect.x !== 0 || observation.clientRect.y !== 0) {
      context.addIssue({
        code: "custom",
        message: "client rectangle must be client-relative",
        path: ["clientRect"],
      });
    }
    if (
      observation.screenshot.width > observation.clientRect.width ||
      observation.screenshot.height > observation.clientRect.height
    ) {
      context.addIssue({
        code: "custom",
        message: "screenshot cannot exceed the observed client area",
        path: ["screenshot"],
      });
    }
    const expectedScaleX =
      observation.screenshot.width / observation.clientRect.width;
    const expectedScaleY =
      observation.screenshot.height / observation.clientRect.height;
    if (
      Math.abs(observation.screenshot.scaleX - expectedScaleX) > 1e-9 ||
      Math.abs(observation.screenshot.scaleY - expectedScaleY) > 1e-9
    ) {
      context.addIssue({
        code: "custom",
        message: "screenshot scale does not match its dimensions",
        path: ["screenshot"],
      });
    }
  });

export const VisualObservationEnvelopeSchema = z.object({
  visualObservation: VisualObservationSchema,
});

export type VisualObservation = z.infer<typeof VisualObservationSchema>;
