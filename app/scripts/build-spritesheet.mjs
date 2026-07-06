// Composes the pet spritesheet from the v2 per-animation sheets in
// assets/pet-v2-src/. Each source is one animation: a single horizontal row
// of 8 generated frames on a keyed-out green screen, with spill from the key
// still on the edges. This script scrubs the spill, finds the character in
// each frame, and packs every animation into one fixed-geometry sheet
// (8 columns of 192x208 cells, one row per animation) at
// assets/sandi-spritesheet.webp.
//
// Row order here is the manifest: src/shared/animation-manifest.ts indexes
// rows by position in this list. Change them together.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(appDir, "..", "assets", "pet-v2-src");
const outPath = join(appDir, "..", "assets", "sandi-spritesheet.webp");

const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const COLUMNS = 8;

// Breathing room inside each cell, in output pixels. The bottom margin is the
// visual "ground" the character rests on; sideways margins keep mirrored
// playback (walking-left) from touching the cell edge.
const MARGIN_X = 4;
const MARGIN_TOP = 2;
const MARGIN_BOTTOM = 2;

// Sheet order = manifest row index.
const ROWS = [
  "idle_breath_blink_8f",
  "walk_float_bob_8f",
  "listening_curious_8f",
  "thinking_8f",
  "typing_working_8f",
  "happy_celebrate_8f",
  "startled_error_recovery_8f",
  "magic_cast_8f",
  "sleepy_yawn_nap_8f",
  "picked_up_dragged_wiggle_8f",
];

// Pixels at least this opaque count as character when measuring bounding
// boxes; anything fainter is keying residue or anti-aliased haze.
const BBOX_ALPHA = 10;

// Green-spill thresholds. The sources arrive with the green screen already
// keyed to transparency, but the key left spill on the silhouette: edge
// pixels, some fully opaque, tinted toward the screen green. spill is
// measured as g - max(r, b); residue sits above LO and fades out by HI.
const SPILL_LO = 24;
const SPILL_HI = 96;

// Source pixels erased at each frame window's left and right edge. The
// generated frames are packed tightly enough that wide props (the typing
// keyboard, a walking cape) bleed a sliver into the neighboring frame;
// trimming the seam kills those orphan slivers at the cost of a few edge
// pixels on frames whose own content genuinely reaches the boundary.
const EDGE_TRIM = 4;

// Scrub green-screen spill from one raw RGBA buffer in place. Only pixels
// tinted toward the screen's own green qualify: green-dominant AND low in
// blue, which spares the character's legitimate green-adjacent colors (the
// mint keyboard and the teal gems and runes all carry blue close to or above
// their green). Qualifying pixels lose their green cast, and strongly tinted
// ones fade out entirely since they are keying residue rather than character.
function cleanSpill(data, width, height) {
  for (let i = 0; i < width * height * 4; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const spill = g - Math.max(r, b);
    if (spill <= 0 || b >= 0.6 * g) continue;
    if (spill >= SPILL_HI) {
      data[i + 3] = 0;
      continue;
    }
    if (spill > SPILL_LO) {
      const keep = 1 - (spill - SPILL_LO) / (SPILL_HI - SPILL_LO);
      data[i + 3] = Math.min(data[i + 3], Math.round(255 * keep));
    }
    data[i + 1] = Math.max(r, b);
  }
}

// Alpha-weighted centroid x of [left, left+w), in sheet coordinates. Far more
// robust than a bounding-box center for locating the character: a stray
// particle pixel drags a bbox edge by tens of pixels but barely moves the
// centroid.
function centroidX(data, width, height, left, w) {
  let sum = 0;
  let weight = 0;
  for (let y = 0; y < height; y++) {
    for (let x = left; x < left + w; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= BBOX_ALPHA) continue;
      sum += x * a;
      weight += a;
    }
  }
  if (weight === 0) return undefined;
  return sum / weight;
}

// How far opaque edge colors are pushed out into the transparent region,
// in source pixels. Covers the lanczos3 kernel's reach at the downscale
// factors in play, with margin.
const BLEED_RADIUS = 8;

// Replace the RGB hidden under transparent pixels near the silhouette with
// the nearest opaque color. Transparent pixels keep whatever color the
// upstream keying left behind, and the resampler blends a little of that
// hidden color into the silhouette's edge when the frames are scaled down,
// showing up as a fringe. Dilating the edge colors outward makes anything the
// resampler picks up match the character.
function bleedEdgeColors(data, width, height) {
  let frontier = [];
  const filled = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    if (data[p * 4 + 3] > 0) filled[p] = 1;
  }
  for (let p = 0; p < width * height; p++) {
    if (filled[p]) frontier.push(p);
  }
  for (let step = 0; step < BLEED_RADIUS; step++) {
    const next = [];
    for (const p of frontier) {
      const x = p % width;
      const y = (p - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (filled[np]) continue;
        filled[np] = 1;
        data[np * 4] = data[p * 4];
        data[np * 4 + 1] = data[p * 4 + 1];
        data[np * 4 + 2] = data[p * 4 + 2];
        next.push(np);
      }
    }
    frontier = next;
  }
}

// The character's bounding box within [left, left+w) of the sheet, or
// undefined when the span is empty.
function bboxIn(data, width, height, left, w) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = left; x < left + w; x++) {
      if (data[(y * width + x) * 4 + 3] <= BBOX_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return undefined;
  return { minX, minY, maxX, maxY };
}

// Least-squares line through (0..n-1, values): [intercept, slope].
function fitLine(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - meanX) * (v - meanY);
    den += (i - meanX) * (i - meanX);
  });
  const slope = num / den;
  return [meanY - slope * meanX, slope];
}

// Where each frame's character actually sits. The generated characters are
// spaced at a pitch slightly wider than width/8, so slicing by even division
// leaves the character drifting sideways across the row (a visible slide and
// snap-back once the animation loops in the app). Measure each frame's
// centroid under naive slicing, fit a line through the centroids, and cut
// every frame's window around its fitted center instead: the systematic drift
// lands in the window placement, while genuine frame-to-frame sway (a weight
// shift, a hop) survives as the residual.
function frameWindows(data, width, height) {
  const naiveWidth = width / COLUMNS;
  const centers = [];
  for (let i = 0; i < COLUMNS; i++) {
    const left = Math.round(i * naiveWidth);
    const right = Math.round((i + 1) * naiveWidth);
    const center = centroidX(data, width, height, left, right - left);
    if (center === undefined)
      throw new Error(`frame ${i} is empty after keying`);
    centers.push(center);
  }
  const [c0, pitch] = fitLine(centers);
  const windowWidth = Math.min(Math.round(naiveWidth), Math.round(pitch));
  return Array.from({ length: COLUMNS }, (_, i) => {
    const center = c0 + pitch * i;
    const left = Math.round(center - windowWidth / 2);
    return {
      left: Math.max(0, Math.min(left, width - windowWidth)),
      width: windowWidth,
    };
  });
}

// Copy one frame window out of the sheet buffer with its seam edges erased,
// so a neighbor's bleed sliver cannot widen the bounding box or survive into
// the output. Windows may overlap, so the erase happens on the copy.
function extractWindow(data, width, window, height) {
  const out = Buffer.alloc(window.width * height * 4);
  for (let y = 0; y < height; y++) {
    data.copy(
      out,
      y * window.width * 4,
      (y * width + window.left) * 4,
      (y * width + window.left + window.width) * 4,
    );
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < EDGE_TRIM; x++) {
      out[(y * window.width + x) * 4 + 3] = 0;
      out[(y * window.width + (window.width - 1 - x)) * 4 + 3] = 0;
    }
  }
  return out;
}

async function buildRow(name, rowIndex) {
  const raw = await sharp(await readFile(join(srcDir, `${name}.webp`)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = raw.info;
  cleanSpill(raw.data, width, height);
  bleedEdgeColors(raw.data, width, height);

  const windows = frameWindows(raw.data, width, height);
  const frames = windows.map((window) => {
    const data = extractWindow(raw.data, width, window, height);
    const bbox = bboxIn(data, window.width, height, 0, window.width);
    if (!bbox) throw new Error(`${name}: a recut frame is empty`);
    return { data, width: window.width, bbox };
  });

  // The union of all frame bounding boxes, in window-local coordinates, is
  // the animation's stage. Scaling and anchoring the stage (not each frame)
  // keeps per-frame motion: a hop stays a hop instead of being re-centered
  // away.
  const union = frames.reduce(
    (acc, { bbox }) => ({
      minX: Math.min(acc.minX, bbox.minX),
      minY: Math.min(acc.minY, bbox.minY),
      maxX: Math.max(acc.maxX, bbox.maxX),
      maxY: Math.max(acc.maxY, bbox.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

  const unionWidth = union.maxX - union.minX + 1;
  const unionHeight = union.maxY - union.minY + 1;
  const scale = Math.min(
    (FRAME_WIDTH - 2 * MARGIN_X) / unionWidth,
    (FRAME_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) / unionHeight,
  );
  const scaledWidth = Math.max(1, Math.round(unionWidth * scale));
  const scaledHeight = Math.max(1, Math.round(unionHeight * scale));
  // Center the stage horizontally, rest it on the bottom margin.
  const cellX = Math.round((FRAME_WIDTH - scaledWidth) / 2);
  const cellY = FRAME_HEIGHT - MARGIN_BOTTOM - scaledHeight;

  const composites = [];
  for (const [i, frame] of frames.entries()) {
    const stage = await sharp(frame.data, {
      raw: { width: frame.width, height, channels: 4 },
    })
      .extract({
        left: union.minX,
        top: union.minY,
        width: unionWidth,
        height: unionHeight,
      })
      .resize(scaledWidth, scaledHeight, { kernel: "lanczos3" })
      .png()
      .toBuffer();
    composites.push({
      input: stage,
      left: i * FRAME_WIDTH + cellX,
      top: rowIndex * FRAME_HEIGHT + cellY,
    });
  }

  console.log(
    `${name}: union ${unionWidth}x${unionHeight}, scale ${scale.toFixed(3)}`,
  );
  return composites;
}

async function main() {
  const composites = [];
  for (const [rowIndex, name] of ROWS.entries()) {
    composites.push(...(await buildRow(name, rowIndex)));
  }
  await sharp({
    create: {
      width: FRAME_WIDTH * COLUMNS,
      height: FRAME_HEIGHT * ROWS.length,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ lossless: true })
    .toFile(outPath);
  console.log(`spritesheet: wrote ${outPath}`);
}

await main();
