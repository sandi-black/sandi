import assert from "node:assert/strict";

import type { LinkStatus } from "@shared/ipc-contract";

import { createLinkManager } from "./link-manager";
import type { DesktopClientOptions } from "@sandi-server/surfaces/api/client/desktop-client";

type ControlledRun = {
  options: DesktopClientOptions;
};

async function main(): Promise<void> {
  const runs: ControlledRun[] = [];
  const statuses: LinkStatus[] = [];
  const manager = createLinkManager({
    rootDir: "C:\\Users\\Ada",
    events: {
      onStatus: (status) => statuses.push(status),
      onResponseChunk: () => undefined,
      onResponseAttachment: () => undefined,
    },
    loadCredentials: async () => ({
      url: "https://example.com",
      token: "a".repeat(64),
      identityId: "ada",
      deviceId: "analytical-engine",
    }),
    runClient: (options) =>
      new Promise<void>((resolve) => {
        runs.push({ options });
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  });

  const initialRun = manager.start();
  await waitFor(() => runs.length === 1);
  const first = runs[0];
  assert.ok(first);
  first.options.onStatus?.("linked");
  assert.equal(manager.status().state, "linked");

  // Both calls initially observe the same old run. The generation gate lets
  // only the newest replacement launch after that run acknowledges abort.
  const restartOne = manager.restart();
  const restartTwo = manager.restart();
  await Promise.all([initialRun, restartOne, restartTwo]);
  await waitFor(() => runs.length === 2);
  assert.equal(runs.length, 2, "rapid restarts launch one replacement");
  assert.equal(first.options.signal?.aborted, true, "old link was aborted");
  assert.equal(manager.status().state, "connecting");

  first.options.onStatus?.("linked");
  assert.equal(
    manager.status().state,
    "connecting",
    "stale callbacks cannot overwrite the replacement's status",
  );
  const replacement = runs[1];
  assert.ok(replacement);
  replacement.options.onStatus?.("linked");
  assert.equal(manager.status().state, "linked");

  manager.stop();
  await waitFor(() => replacement.options.signal?.aborted === true);
  assert.equal(
    replacement.options.signal?.aborted,
    true,
    "stop owns and aborts the replacement link",
  );

  console.log("verify-link-manager: ok");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

await main();
