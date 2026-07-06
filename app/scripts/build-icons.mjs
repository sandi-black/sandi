// Generates the app and tray icons from the repo's shared Sandi portrait.
// Output lands in app/build/icons/ (gitignored); the dev and build scripts run
// this first, skipping work when the outputs are already newer than the
// source.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(appDir, "..", "assets", "sandi.png");
const outDir = join(appDir, "build", "icons");
const icoPath = join(outDir, "icon.ico");
const trayPath = join(outDir, "tray-icon.png");

async function isFresh(target) {
  try {
    const [targetStat, sourceStat] = await Promise.all([
      stat(target),
      stat(source),
    ]);
    return targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  if ((await isFresh(icoPath)) && (await isFresh(trayPath))) {
    return;
  }
  await mkdir(outDir, { recursive: true });

  const resize = (size) =>
    sharp(source)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

  // Multi-resolution .ico for the installer, taskbar-free as the app is, the
  // exe still carries one.
  const icoSizes = [16, 24, 32, 48, 256];
  const icoPngs = await Promise.all(icoSizes.map(resize));
  await writeFile(icoPath, await pngToIco(icoPngs));

  // Windows renders tray icons small; a 32px source downscales cleanly at
  // both 100% and 200% display scaling.
  await writeFile(trayPath, await resize(32));

  console.log(`icons: wrote ${icoPath} and ${trayPath}`);
}

await main();
