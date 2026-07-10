import { resolve } from "node:path";

/**
 * Canonical env-overridable roots for pi-extension tools. These run under the
 * Pi CLI outside the app runtime, so the working-directory-relative defaults
 * here are the contract with the process that spawns the extension.
 */
export function assetsRoot(): string {
  return resolve(process.env["SANDI_ASSETS_ROOT"]?.trim() || "assets");
}

export function dataRoot(): string {
  return resolve(process.env["SANDI_DATA_DIR"]?.trim() || "data");
}
