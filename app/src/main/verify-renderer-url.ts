import assert from "node:assert/strict";

import { parseRendererDevServerUrl } from "./renderer-url";

// The dev-server URL boundary: absent and blank values disable the dev path,
// loopback http origins pass through normalized, everything else throws.
// Run with: npm run verify:renderer-url -w app

assert.equal(parseRendererDevServerUrl(undefined), undefined, "unset");
assert.equal(parseRendererDevServerUrl(""), undefined, "empty");
assert.equal(parseRendererDevServerUrl("   "), undefined, "blank");

assert.equal(
  parseRendererDevServerUrl("http://localhost:5173"),
  "http://localhost:5173",
  "localhost origin passes",
);
assert.equal(
  parseRendererDevServerUrl("http://127.0.0.1:5173/"),
  "http://127.0.0.1:5173",
  "loopback ip normalizes to origin",
);

assert.throws(
  () => parseRendererDevServerUrl("not a url"),
  /not a valid URL/,
  "garbage throws",
);
assert.throws(
  () => parseRendererDevServerUrl("https://localhost:5173"),
  /loopback http origin/,
  "https rejected",
);
assert.throws(
  () => parseRendererDevServerUrl("http://example.com:5173"),
  /loopback http origin/,
  "non-loopback host rejected",
);

console.log("verify-renderer-url: ok");
