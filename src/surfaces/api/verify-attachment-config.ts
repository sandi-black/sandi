import assert from "node:assert/strict";

import { loadApiConfig } from "@/surfaces/api/config";

const names = [
  "SANDI_ATTACHMENT_QUOTA_BYTES",
  "SANDI_ATTACHMENT_RETENTION_DAYS",
  "SANDI_ATTACHMENT_CLEANUP_INTERVAL_HOURS",
] as const;
const saved = new Map(names.map((name) => [name, process.env[name]]));

try {
  for (const name of names) delete process.env[name];
  const defaults = loadApiConfig("data");
  assert.equal(defaults.attachmentQuotaBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(defaults.attachmentRetentionMs, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(defaults.attachmentCleanupIntervalMs, 24 * 60 * 60 * 1_000);

  process.env["SANDI_ATTACHMENT_QUOTA_BYTES"] = "4096";
  process.env["SANDI_ATTACHMENT_RETENTION_DAYS"] = "7";
  process.env["SANDI_ATTACHMENT_CLEANUP_INTERVAL_HOURS"] = "12";
  const configured = loadApiConfig("data");
  assert.equal(configured.attachmentQuotaBytes, 4_096);
  assert.equal(configured.attachmentRetentionMs, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(configured.attachmentCleanupIntervalMs, 12 * 60 * 60 * 1_000);

  process.env["SANDI_ATTACHMENT_RETENTION_DAYS"] = "0";
  assert.throws(() => loadApiConfig("data"), /positive safe integer/u);
} finally {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("attachment policy configuration verification passed");
