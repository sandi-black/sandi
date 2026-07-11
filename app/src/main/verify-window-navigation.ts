import assert from "node:assert/strict";

import { parseExternalHttpUrl } from "./external-url";

assert.equal(
  parseExternalHttpUrl("https://example.com/docs?q=sandi#start"),
  "https://example.com/docs?q=sandi#start",
  "https links open externally",
);
assert.equal(
  parseExternalHttpUrl("http://localhost:5173/help"),
  "http://localhost:5173/help",
  "loopback http links remain valid external links",
);

for (const rejected of [
  "file:///C:/Users/me/.ssh/id_ed25519",
  "javascript:alert(1)",
  "data:text/html,hello",
  "sandi-asset:///private/file",
  "https://user:secret@example.com/",
  "https://example.com/\n--flag",
  "not a url",
  "",
]) {
  assert.equal(
    parseExternalHttpUrl(rejected),
    undefined,
    `rejects unsafe external URL: ${JSON.stringify(rejected)}`,
  );
}

assert.equal(
  parseExternalHttpUrl(`https://example.com/${"a".repeat(8_192)}`),
  undefined,
  "rejects an excessively long external URL before parsing",
);

console.log("verify-window-navigation: ok");
