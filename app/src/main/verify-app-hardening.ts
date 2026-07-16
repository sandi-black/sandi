import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { appRendererUrl, resolveAppRequest } from "./app-url";

const rendererRoot = join(import.meta.dirname, "../renderer");

assert.equal(appRendererUrl("chat"), "sandi-app://app/chat/index.html");
assert.equal(
  resolveAppRequest("sandi-app://app/assets/app.js", rendererRoot),
  join(rendererRoot, "assets/app.js"),
);

for (const rejected of [
  "https://chat/index.html",
  "sandi-app://chat/index.html",
  "sandi-app://app/chat/index.html?remote=true",
  "sandi-app://app/%E0%A4%A",
  "not a url",
]) {
  assert.equal(
    resolveAppRequest(rejected, rendererRoot),
    undefined,
    `rejects renderer request: ${rejected}`,
  );
}

for (const surface of ["chat", "pet"]) {
  const html = await readFile(
    join(rendererRoot, surface, "index.html"),
    "utf8",
  );
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src 'self' sandi-asset:/);
  assert.doesNotMatch(html, /img-src[^;]*https?:/);
}

console.log("verify-app-hardening: ok");
