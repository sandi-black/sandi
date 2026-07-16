import { existsSync } from "node:fs";

import type { App } from "electron";

export function installPackagedSmokeExit(app: App): void {
  const exitFile = process.env["SANDI_PACKAGED_SMOKE_EXIT_FILE"];
  if (exitFile === undefined) return;

  const timer = setInterval(() => {
    if (!existsSync(exitFile)) return;
    clearInterval(timer);
    app.quit();
  }, 50);
  timer.unref();
  app.once("will-quit", () => clearInterval(timer));
}
