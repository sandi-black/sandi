import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  PET_ROWS,
  type PetRow,
  type RowSpec,
} from "@shared/animation-manifest";

// Draws the active spritesheet row onto the pet canvas on a
// requestAnimationFrame loop, and exposes per-frame alpha lookups so the
// window can pass clicks through the sprite's transparent pixels.

import sheetUrl from "@assets/sandi-spritesheet.webp";

export type SpritePlayer = {
  setRow(row: PetRow): void;
  setReplyAlertVisible(visible: boolean): void;
  // Alpha (0-255) of the currently displayed frame at canvas-CSS-pixel
  // coordinates, for click-through sampling.
  alphaAt(x: number, y: number): number;
  // Fired once each time a non-looping row plays through.
  onOneShotComplete(listener: () => void): void;
};

export async function createSpritePlayer(
  canvas: HTMLCanvasElement,
): Promise<SpritePlayer> {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d canvas context unavailable");

  // Backing store at device pixels for a crisp sprite on HiDPI displays.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = FRAME_WIDTH * dpr;
  canvas.height = FRAME_HEIGHT * dpr;
  context.scale(dpr, dpr);
  context.imageSmoothingEnabled = false;

  const sheet = await loadSheet(sheetUrl);

  // A 1x offscreen copy of the current frame backs the alpha lookups; reading
  // one pixel per pointer move from a 192x208 buffer is cheap.
  const sample = document.createElement("canvas");
  sample.width = FRAME_WIDTH;
  sample.height = FRAME_HEIGHT;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) throw new Error("2d sampling context unavailable");

  let row: PetRow = "idle";
  let rowStartedAt = performance.now();
  let lastDrawn: { row: PetRow; frame: number } | undefined;
  let completeListener: (() => void) | undefined;
  let completeFired = false;
  let replyAlertVisible = false;

  const drawReplyAlert = (target: CanvasRenderingContext2D): void => {
    if (!replyAlertVisible) return;

    target.save();
    target.textAlign = "center";
    target.textBaseline = "middle";
    target.font = "bold 34px sans-serif";
    target.lineJoin = "round";
    // A tiny outlined shout-mark, visible on bright and dark desktop clutter
    // without needing a larger pet window.
    target.strokeStyle = "white";
    target.lineWidth = 7;
    target.strokeText("!", FRAME_WIDTH / 2, 30);
    target.strokeStyle = "#7f0000";
    target.lineWidth = 3;
    target.strokeText("!", FRAME_WIDTH / 2, 30);
    target.fillStyle = "#ff2020";
    target.fillText("!", FRAME_WIDTH / 2, 30);
    target.restore();
  };

  // Paint one sheet frame over a whole target context, honoring the row's
  // mirror flag (the walk art faces left; rightward walks draw flipped).
  const paintFrame = (
    target: CanvasRenderingContext2D,
    spec: RowSpec,
    frame: number,
  ): void => {
    const sourceFrame = spec.reverse
      ? (spec.frameOffset ?? 0) + spec.frames - frame - 1
      : (spec.frameOffset ?? 0) + frame;
    const sx = sourceFrame * FRAME_WIDTH;
    const sy = spec.index * FRAME_HEIGHT;
    target.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    if (spec.mirror) {
      target.save();
      target.scale(-1, 1);
      target.drawImage(
        sheet,
        sx,
        sy,
        FRAME_WIDTH,
        FRAME_HEIGHT,
        -FRAME_WIDTH,
        0,
        FRAME_WIDTH,
        FRAME_HEIGHT,
      );
      target.restore();
      return;
    }
    target.drawImage(
      sheet,
      sx,
      sy,
      FRAME_WIDTH,
      FRAME_HEIGHT,
      0,
      0,
      FRAME_WIDTH,
      FRAME_HEIGHT,
    );
  };

  const draw = (now: number): void => {
    const spec = PET_ROWS[row];
    const elapsed = (now - rowStartedAt) / 1000;
    const rawFrame = Math.floor(elapsed * spec.fps);
    let frame: number;
    if (spec.loop) {
      frame = rawFrame % spec.frames;
    } else {
      frame = Math.min(rawFrame, spec.frames - 1);
      if (rawFrame >= spec.frames && !completeFired) {
        completeFired = true;
        completeListener?.();
      }
    }
    if (lastDrawn && lastDrawn.row === row && lastDrawn.frame === frame) {
      requestAnimationFrame(draw);
      return;
    }
    lastDrawn = { row, frame };
    paintFrame(context, spec, frame);
    drawReplyAlert(context);
    paintFrame(sampleContext, spec, frame);
    drawReplyAlert(sampleContext);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  return {
    setRow(next) {
      if (next === row) return;
      row = next;
      rowStartedAt = performance.now();
      completeFired = false;
    },
    setReplyAlertVisible(visible) {
      if (replyAlertVisible === visible) return;
      replyAlertVisible = visible;
      lastDrawn = undefined;
    },
    alphaAt(x, y) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px < 0 || py < 0 || px >= FRAME_WIDTH || py >= FRAME_HEIGHT) {
        return 0;
      }
      return sampleContext.getImageData(px, py, 1, 1).data[3] ?? 0;
    },
    onOneShotComplete(listener) {
      completeListener = listener;
    },
  };
}

async function loadSheet(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  const blob = await response.blob();
  return createImageBitmap(blob);
}
