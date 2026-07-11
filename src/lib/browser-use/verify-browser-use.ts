import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logging";
import type { BrowserUseConfig } from "./config";
import { startBrowserUseReaper } from "./reaper";
import { BrowserUseService } from "./service";
import { z } from "zod/v4";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-10T00:00:00.000Z";

const requests: Array<{ method: string; path: string; body: unknown }> = [];
let taskCount = 0;
let stopCount = 0;
let profileCount = 0;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({ method: request.method ?? "GET", path, body });
    response.setHeader("Content-Type", "application/json");

    if (request.method === "POST" && path === "/api/v3/profiles") {
      profileCount += 1;
      response.end(
        JSON.stringify({
          id: PROFILE_ID,
          name: "personal-demo",
          userId: "ada",
          createdAt: NOW,
          updatedAt: NOW,
          cookieDomains: [],
        }),
      );
      return;
    }

    if (request.method === "POST" && path === "/api/v3/sessions") {
      const parsed = z
        .object({ task: z.string().optional() })
        .passthrough()
        .parse(body ?? {});
      if (parsed.task) taskCount += 1;
      response.end(
        JSON.stringify(
          sessionResponse({
            status: "idle",
            output: parsed.task ? `completed task ${taskCount}` : null,
            totalCostUsd: String(taskCount * 0.01),
          }),
        ),
      );
      return;
    }

    if (
      request.method === "GET" &&
      path === `/api/v3/sessions/${PROVIDER_SESSION_ID}/messages`
    ) {
      response.end(JSON.stringify({ messages: [], hasMore: false }));
      return;
    }

    if (
      request.method === "GET" &&
      path === `/api/v3/sessions/${PROVIDER_SESSION_ID}`
    ) {
      response.end(
        JSON.stringify(
          sessionResponse({
            status: "idle",
            output: taskCount > 0 ? `completed task ${taskCount}` : null,
            totalCostUsd: String(taskCount * 0.01),
          }),
        ),
      );
      return;
    }

    if (
      request.method === "POST" &&
      path === `/api/v3/sessions/${PROVIDER_SESSION_ID}/stop`
    ) {
      stopCount += 1;
      response.end(
        JSON.stringify(
          sessionResponse({
            status: "stopped",
            output: null,
            totalCostUsd: String(taskCount * 0.01),
          }),
        ),
      );
      return;
    }

    response.statusCode = 404;
    response.end(
      JSON.stringify({ detail: `Unhandled ${request.method} ${path}` }),
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("verification server did not bind a TCP port");
}

const root = await mkdtemp(join(tmpdir(), "sandi-browser-use-"));
const statePath = join(root, "state.json");
const config: BrowserUseConfig = {
  apiKey: "test-browser-use-key",
  baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
  statePath,
  model: "bu-mini",
  maxTaskCostUsd: 0.25,
  maxSessionMinutes: 30,
  maxConcurrentSessions: 1,
  handoffTtlMs: 10 * 60_000,
  reaperIntervalMs: 60_000,
};
const service = new BrowserUseService(config);
const context = { identityId: "ada", conversationId: "surface:g:c:t" };

try {
  const started = await service.startSession({
    context,
    profileAlias: "personal-demo",
    task: "Open the demo login and stop before entering credentials.",
  });
  assert.equal(started.output, "completed task 1");
  assert.equal(started.successful, true);
  assert.equal(profileCount, 1, "a profile is created once");
  assert.equal(taskCount, 1, "the first browser task runs");

  await assert.rejects(
    service.startSession({
      context,
      profileAlias: "second-profile",
      task: "This must be rejected before provider work.",
    }),
    /configured limit is 1/,
  );

  const handoff = await service.requestHandoff({
    context: {
      ...context,
      requesterPlatformUserId: "1234",
      surfaceTargetId: "target-1",
    },
    sessionId: started.sessionId,
    reason: "Complete the login, then choose Continue.",
  });
  assert.equal(handoff.state, "awaiting-human");
  await assert.rejects(
    service.liveUrl({
      sessionId: started.sessionId,
      requesterPlatformUserId: "9999",
    }),
    /not available to this user/,
  );
  assert.equal(
    await service.liveUrl({
      sessionId: started.sessionId,
      requesterPlatformUserId: "1234",
    }),
    "https://live.example/session",
  );

  const rawState = await readFile(statePath, "utf8");
  assert.doesNotMatch(rawState, /live\.example|cdp|test-browser-use-key/iu);

  await service.acceptHandoff({
    sessionId: started.sessionId,
    requesterPlatformUserId: "1234",
  });
  const continued = await service.continueSession({
    context,
    sessionId: started.sessionId,
    task: "Confirm the authenticated page is open.",
  });
  assert.equal(continued.output, "completed task 2");
  assert.equal(taskCount, 2, "continuation runs in the same provider session");

  const closed = await service.stopOwnedSession({
    context,
    sessionId: started.sessionId,
  });
  assert.equal(closed.state, "closed");
  assert.equal(stopCount, 1, "normal completion explicitly stops the session");

  const reused = await service.startSession({
    context,
    profileAlias: "personal-demo",
    task: "Check that the saved profile is still authenticated.",
  });
  assert.equal(profileCount, 1, "the named profile is reused");
  const secondHandoff = await service.requestHandoff({
    context: {
      ...context,
      requesterPlatformUserId: "1234",
      surfaceTargetId: "target-1",
    },
    sessionId: reused.sessionId,
    reason: "Wait for cleanup verification.",
  });
  await service.store.updateSession(secondHandoff.id, (session) => {
    if (session.state !== "awaiting-human") return session;
    return {
      ...session,
      handoff: {
        ...session.handoff,
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    };
  });
  const reaper = startBrowserUseReaper({ service, logger: quietLogger() });
  await reaper.sweep();
  reaper.stop();
  assert.equal(
    (await service.sessionStatus(context, reused.sessionId)).state,
    "closed",
  );
  assert.equal(stopCount, 2, "expired handoff is explicitly stopped");

  const taskRequests = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === "/api/v3/sessions" &&
      z
        .object({ task: z.string().optional() })
        .passthrough()
        .parse(request.body ?? {}).task !== undefined,
  );
  for (const request of taskRequests) {
    const body = z
      .object({
        maxCostUsd: z.union([z.string(), z.number()]),
        keepAlive: z.literal(true),
        skills: z.literal(false),
        agentmail: z.literal(false),
        enableScheduledTasks: z.literal(false),
      })
      .passthrough()
      .parse(request.body);
    assert.equal(Number(body.maxCostUsd), 0.25);
  }

  console.log("Browser Use verification passed");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}

function sessionResponse(input: {
  status: "idle" | "stopped";
  output: string | null;
  totalCostUsd: string;
}): Record<string, unknown> {
  return {
    id: PROVIDER_SESSION_ID,
    status: input.status,
    model: "bu-mini",
    output: input.output,
    stepCount: input.output ? 1 : 0,
    isTaskSuccessful: input.output ? true : null,
    liveUrl: "https://live.example/session",
    recordingUrls: [],
    profileId: PROFILE_ID,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    proxyUsedMb: "0",
    llmCostUsd: input.totalCostUsd,
    proxyCostUsd: "0",
    browserCostUsd: "0",
    totalCostUsd: input.totalCostUsd,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function quietLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}
