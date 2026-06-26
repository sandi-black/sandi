import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import { createPairing } from "@/lib/pairing/pairing-store";
import type {
  ModelProviderClient,
  ProviderProbe,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import { apiConversationStorageId } from "@/surfaces/api/api/conversations";
import {
  ApiTokenStore,
  type ApiTokensFile,
  hashApiToken,
  loadApiTokens,
} from "@/surfaces/api/auth/tokens";
import { ApiBot } from "@/surfaces/api/bot/api-bot";
import type { ApiAppConfig } from "@/surfaces/api/config";
import { API_SURFACE_CONTEXT } from "@/surfaces/api/runtime/context";

const RAW_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const UNMAPPED_TOKEN =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const IDENTITY_ID = "tester";
const UNMAPPED_IDENTITY_ID = "ghost";
const DEVICE_ID = "device-1";
const CONVERSATION_ID = "session-1";

async function verifyApiBot(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "sandi-api-bot-"));
  const provider = new RecordingProvider();
  const config = testConfig(dataDir);
  const bot = new ApiBot({
    config,
    conversations: new ConversationStore(dataDir),
    contextCompiler: new ContextCompiler(
      config.paths.configDirs,
      config.paths.dataDir,
      API_SURFACE_CONTEXT,
    ),
    provider,
  });

  try {
    await writeFixtures(dataDir);
    await bot.start();
    const port = bot.address()?.port;
    if (!port) throw new Error("API bot did not expose a listening port");
    const base = `http://127.0.0.1:${port}`;

    await verifyHealth(base);
    await verifyMissingAuthIsRejected(base, provider);
    await verifyMalformedSchemeIsRejected(base, provider);
    await verifyWrongBearerIsRejected(base, provider);
    await verifyUnmappedIdentityIsRejected(base, provider);
    await verifyMalformedTurnIdIsRejected(base, provider);
    await verifyValidTurn(base, provider);
    await verifySecondTurnDoesNotDuplicateParticipant(base);
    await verifyManifestPersisted(dataDir);
    await verifyTokenRevocationAndEnrollment(dataDir);
    await verifyDeviceRoutes(base);
    await verifyPairing(base, config);
  } finally {
    bot.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function verifyHealth(base: string): Promise<void> {
  const response = await fetch(`${base}/v1/health`);
  assertEqual(response.status, 200, "health status");
  const body = await response.json();
  assertEqual(isRecord(body) && body["ok"], true, "health ok");
  assertEqual(isRecord(body) && body["surface"], "api", "health surface");
  console.log("ok GET /v1/health returns 200 { ok: true, surface: api }");
}

async function verifyMissingAuthIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
  });
  assertEqual(response.status, 401, "missing auth status");
  assertEqual(provider.callCount, before, "missing auth provider not called");
  console.log(
    "ok POST turn without Authorization returns 401, provider untouched",
  );
}

async function verifyMalformedSchemeIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  // A token with embedded whitespace and a wrong scheme must not parse to a
  // bearer token at all, so it fails closed as unauthorized.
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Token ${RAW_TOKEN} extra`,
    },
    body: JSON.stringify({ input: "hello" }),
  });
  assertEqual(response.status, 401, "malformed scheme status");
  assertEqual(
    provider.callCount,
    before,
    "malformed scheme provider not called",
  );
  console.log("ok POST turn with malformed Authorization scheme returns 401");
}

async function verifyWrongBearerIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization:
        "Bearer ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    body: JSON.stringify({ input: "hello" }),
  });
  assertEqual(response.status, 401, "wrong bearer status");
  assertEqual(provider.callCount, before, "wrong bearer provider not called");
  console.log("ok POST turn with wrong bearer returns 401, provider untouched");
}

async function verifyUnmappedIdentityIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  // A valid token whose identity is not present in humans.json must fail closed
  // with 403 before the provider is ever asked to generate a turn.
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${UNMAPPED_TOKEN}`,
    },
    body: JSON.stringify({ input: "hello" }),
  });
  assertEqual(response.status, 403, "unmapped identity status");
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["error"],
    "identity_unmapped",
    "unmapped identity error code",
  );
  assertEqual(
    provider.callCount,
    before,
    "unmapped identity provider not called",
  );
  console.log(
    "ok POST turn with unmapped identity returns 403, provider untouched",
  );
}

async function verifyMalformedTurnIdIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  // turnId is optional, but when present it must be a non-empty string. A
  // malformed value is rejected at the request boundary with 400 before the
  // provider runs, so a bad id cannot drive a turn or bind a stream.
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RAW_TOKEN}`,
    },
    body: JSON.stringify({ input: "hello", turnId: 42 }),
  });
  assertEqual(response.status, 400, "malformed turnId status");
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["error"],
    "invalid_turn_id",
    "malformed turnId error code",
  );
  assertEqual(
    provider.callCount,
    before,
    "malformed turnId provider not called",
  );
  console.log(
    "ok POST turn with a malformed turnId returns 400, provider untouched",
  );
}

async function verifyValidTurn(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RAW_TOKEN}`,
    },
    // A client-minted turn id rides along so the response stream can bind to this
    // exact turn; it must reach the provider request that drives the pi child.
    body: JSON.stringify({ input: "what is the weather", turnId: "turn-abc" }),
  });
  assertEqual(response.status, 200, "valid turn status");
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["text"],
    provider.responseText,
    "valid turn text",
  );
  assertEqual(
    isRecord(body) && body["conversationId"],
    CONVERSATION_ID,
    "valid turn conversationId",
  );

  const request = provider.lastRequest;
  if (!request) throw new Error("fake provider received no request");
  const expectedCanonical = `api:${IDENTITY_ID}:${DEVICE_ID}:${CONVERSATION_ID}`;
  assertEqual(
    request.conversationId,
    expectedCanonical,
    "provider conversationId",
  );
  assertEqual(request.turnId, "turn-abc", "provider turnId");
  assertEqual(
    request.accountRouting?.identityId,
    IDENTITY_ID,
    "provider accountRouting identityId",
  );
  assertEqual(
    request.surfaceContext?.name,
    "api",
    "provider surfaceContext name",
  );
  assertNonEmpty(request.instructions, "provider compiled instructions");
  // The compiler was built with API_SURFACE_CONTEXT, so the compiled prompt must
  // render the API surface (this also exercises API skill filtering / runtime
  // import path selection).
  if (!request.instructions.includes("Surface: api")) {
    console.error("provider instructions: expected to contain 'Surface: api'");
    process.exit(1);
  }

  const participant = request.memoryContext.participants[0];
  if (!participant) throw new Error("provider received no participant");
  // The API caller reuses the human's existing platform identity (Discord in
  // this fixture), so the turn shares that human's memory arena and account
  // routing. The surface stays "api" while the participant platform is the
  // reused account.
  assertEqual(participant.platform, "discord", "participant platform");
  assertEqual(
    participant.platformUserId,
    "111",
    "participant platform user id",
  );
  assertEqual(participant.identityId, IDENTITY_ID, "participant identityId");
  console.log(
    "ok POST valid turn returns 200 reusing the human's Discord identity",
  );
}

async function verifySecondTurnDoesNotDuplicateParticipant(
  base: string,
): Promise<void> {
  const response = await fetch(turnsUrl(base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RAW_TOKEN}`,
    },
    body: JSON.stringify({ input: "again" }),
  });
  assertEqual(response.status, 200, "second turn status");
  console.log("ok POST second turn to same conversation returns 200");
}

async function verifyManifestPersisted(dataDir: string): Promise<void> {
  const storageId = apiConversationStorageId({
    identityId: IDENTITY_ID,
    deviceId: DEVICE_ID,
    conversationId: CONVERSATION_ID,
  });
  const manifestPath = join(
    dataDir,
    "conversations",
    storageId,
    "manifest.json",
  );
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(manifest)) throw new Error("manifest is not an object");
  assertEqual(manifest["surface"], "api", "manifest surface");
  assertEqual(
    manifest["canonicalId"],
    `api:${IDENTITY_ID}:${DEVICE_ID}:${CONVERSATION_ID}`,
    "manifest canonicalId",
  );
  assertEqual(manifest["kind"], "session", "manifest kind");
  const participants = manifest["participants"];
  assertEqual(
    Array.isArray(participants) ? participants.length : -1,
    1,
    "manifest participant count",
  );
  console.log("ok persisted manifest exists with exactly one participant");
}

async function verifyTokenRevocationAndEnrollment(
  dataDir: string,
): Promise<void> {
  // ApiTokenStore must reload api-tokens.json when it changes so that revoked
  // tokens stop working and newly enrolled tokens start working without a
  // process restart. ttlMs: 0 forces a re-stat on every check so the test does
  // not have to sleep out a cache window.
  const path = join(dataDir, "revocation-tokens.json");
  const liveToken = "a".repeat(64);
  const newToken = "b".repeat(64);

  await writeTokensFile(path, [
    { token: liveToken, identityId: IDENTITY_ID, deviceId: DEVICE_ID },
  ]);
  const store = new ApiTokenStore(path, 0);

  const before = await store.verify(liveToken);
  assertEqual(before?.identityId, IDENTITY_ID, "token store initial match");

  // Revoke: rewrite the file without the live token.
  await writeTokensFile(path, [
    { token: newToken, identityId: IDENTITY_ID, deviceId: "device-2" },
  ]);
  const revoked = await store.verify(liveToken);
  assertEqual(revoked, undefined, "revoked token rejected after reload");

  // Enroll: the freshly added token now authenticates.
  const enrolled = await store.verify(newToken);
  assertEqual(enrolled?.deviceId, "device-2", "newly enrolled token accepted");
  console.log(
    "ok token store honors revocation and enrollment without restart",
  );
}

// Exercises the device link and result routes over HTTP: both require a valid
// bearer token, the link opens an SSE stream, and a result for an unknown call
// fails closed. The full dispatch round-trip (broker to device and back) is
// covered at the unit level in verify-tool-broker.
async function verifyDeviceRoutes(base: string): Promise<void> {
  const linkUrl = `${base}/v1/devices/link`;
  const resultUrl = `${base}/v1/devices/result`;

  const noAuthLink = await fetch(linkUrl);
  assertEqual(noAuthLink.status, 401, "device link without auth is 401");
  await noAuthLink.body?.cancel();

  const noAuthResult = await fetch(resultUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "x", ok: true, output: "" }),
  });
  assertEqual(noAuthResult.status, 401, "device result without auth is 401");

  const wrongMethod = await fetch(linkUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${RAW_TOKEN}` },
  });
  assertEqual(wrongMethod.status, 405, "POST to the device link is 405");
  await wrongMethod.body?.cancel();

  // No link is open for this device, so a result references no pending call and
  // fails closed rather than being silently dropped.
  const unknownResult = await fetch(resultUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${RAW_TOKEN}`,
    },
    body: JSON.stringify({ id: "missing", ok: true, output: "x" }),
  });
  assertEqual(unknownResult.status, 404, "result for an unknown call is 404");

  // Opening the link returns a live SSE stream.
  const controller = new AbortController();
  try {
    const link = await fetch(linkUrl, {
      headers: { authorization: `Bearer ${RAW_TOKEN}` },
      signal: controller.signal,
    });
    assertEqual(link.status, 200, "device link opens with 200");
    const contentType = link.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      console.error(
        `device link content-type: expected text/event-stream, got ${contentType}`,
      );
      process.exit(1);
    }
    const reader = link.body?.getReader();
    if (reader) {
      const first = await reader.read();
      const text = first.value ? Buffer.from(first.value).toString("utf8") : "";
      if (!text.includes(": linked")) {
        console.error("device link: expected an initial ': linked' comment");
        process.exit(1);
      }
      await reader.cancel();
    }
  } finally {
    controller.abort();
  }
  console.log(
    "ok device routes require auth, open an SSE stream, and fail closed on unknown results",
  );
}

// Exercises the full Discord-mediated enrollment loop end to end over HTTP: a
// code issued by the (separate) identity-bearing surface is redeemed here for a
// per-device token, and every failure path fails closed. The code is created
// directly through the shared store, exactly as the other surface would.
async function verifyPairing(
  base: string,
  config: ApiAppConfig,
): Promise<void> {
  const url = `${base}/v1/auth/pair`;

  // Happy path: a valid code mints a per-device token bound to the identity.
  const pairing = await createPairing({
    path: config.api.pairingsPath,
    identityId: IDENTITY_ID,
  });
  const redeemed = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      deviceId: "paired-device",
      label: "Paired laptop",
    }),
  });
  assertEqual(redeemed.status, 200, "pair redeem status");
  const body = await redeemed.json();
  if (!isRecord(body)) throw new Error("pair response is not an object");
  assertEqual(body["identityId"], IDENTITY_ID, "pair identityId");
  assertEqual(body["deviceId"], "paired-device", "pair deviceId");
  assertEqual(body["label"], "Paired laptop", "pair label");
  const token = body["token"];
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    console.error("pair token: expected a 64-char hex token");
    process.exit(1);
  }

  // The minted token is persisted and actually authenticates: verify it through
  // a fresh token store (ttl 0) so the assertion does not depend on the bot's
  // own cache window.
  const store = new ApiTokenStore(config.api.tokensPath, 0);
  const entry = await store.verify(token);
  assertEqual(entry?.identityId, IDENTITY_ID, "minted token identity");
  assertEqual(entry?.deviceId, "paired-device", "minted token device");

  // The freshly minted token authenticates a turn against the same running bot
  // immediately, with no cache-window 401 (the bot's token store re-stats on
  // every check).
  const pairedTurn = await fetch(
    `${base}/v1/conversations/${encodeURIComponent("paired-session")}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ input: "hello from the paired device" }),
    },
  );
  assertEqual(
    pairedTurn.status,
    200,
    "freshly minted token authenticates a turn at once",
  );

  // Single-use: the same code cannot be redeemed twice.
  const reuse = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assertEqual(reuse.status, 401, "pair single-use rejection");

  // An unknown but well-formed code fails closed.
  const unknown = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ZZZZZ-ZZZZZ" }),
  });
  assertEqual(unknown.status, 401, "pair unknown code rejection");

  // A body with no code is a 400.
  const malformed = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  assertEqual(malformed.status, 400, "pair malformed body rejection");

  // A code bound to an identity that does not map to a platform account fails
  // closed with 403 and mints nothing.
  const ghostPairing = await createPairing({
    path: config.api.pairingsPath,
    identityId: UNMAPPED_IDENTITY_ID,
  });
  const ghost = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: ghostPairing.code }),
  });
  assertEqual(ghost.status, 403, "pair unmapped identity rejection");

  // An identity removed after a code was issued fails closed on redemption with
  // no restart (the bot re-stats humans.json) and mints nothing. This runs last
  // because it removes the mapped identity from the fixture.
  const removalPairing = await createPairing({
    path: config.api.pairingsPath,
    identityId: IDENTITY_ID,
  });
  const tokensBefore = (await loadApiTokens(config.api.tokensPath)).tokens
    .length;
  await writeFile(
    join(config.paths.configDir, "identities", "humans.json"),
    `${JSON.stringify({ version: 1, humans: [] }, null, 2)}\n`,
    "utf8",
  );
  const afterRemoval = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: removalPairing.code }),
  });
  assertEqual(
    afterRemoval.status,
    403,
    "pair after identity removal rejection",
  );
  const tokensAfter = (await loadApiTokens(config.api.tokensPath)).tokens
    .length;
  assertEqual(
    tokensAfter,
    tokensBefore,
    "no token minted for removed identity",
  );

  console.log(
    "ok pairing redeems a single-use code into a per-device token and rejects bad input",
  );
}

async function writeTokensFile(
  path: string,
  entries: { token: string; identityId: string; deviceId: string }[],
): Promise<void> {
  const file: ApiTokensFile = {
    version: 1,
    tokens: entries.map((entry) => ({
      tokenSha256: hashApiToken(entry.token),
      identityId: entry.identityId,
      deviceId: entry.deviceId,
      label: "revocation-test",
    })),
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

async function writeFixtures(dataDir: string): Promise<void> {
  const configDir = join(dataDir, "config");
  await mkdir(join(configDir, "identities"), { recursive: true });
  await writeFile(
    join(configDir, "identities", "humans.json"),
    JSON.stringify(
      {
        version: 1,
        humans: [
          {
            id: IDENTITY_ID,
            displayName: "Tester",
            platforms: {
              discord: { id: "111", username: "tester" },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(configDir, "api-tokens.json"),
    JSON.stringify(
      {
        version: 1,
        tokens: [
          {
            tokenSha256: createHash("sha256")
              .update(RAW_TOKEN, "utf8")
              .digest("hex"),
            identityId: IDENTITY_ID,
            deviceId: DEVICE_ID,
            label: "verify",
          },
          {
            tokenSha256: createHash("sha256")
              .update(UNMAPPED_TOKEN, "utf8")
              .digest("hex"),
            identityId: UNMAPPED_IDENTITY_ID,
            deviceId: DEVICE_ID,
            label: "verify-unmapped",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function turnsUrl(base: string): string {
  return `${base}/v1/conversations/${encodeURIComponent(CONVERSATION_ID)}/turns`;
}

class RecordingProvider implements ModelProviderClient {
  readonly responseText = "Sandi reply from the fake provider.";
  lastRequest: ProviderTurnRequest | undefined;
  callCount = 0;

  async probe(): Promise<ProviderProbe> {
    return {
      command: { ok: true, detail: "ok" },
      version: { ok: true, detail: "ok" },
      model: { ok: true, detail: "ok" },
    };
  }

  async generateTurn(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    this.callCount += 1;
    this.lastRequest = request;
    return {
      text: this.responseText,
      deliverySideEffects: false,
      raw: null,
    };
  }
}

function testConfig(dataDir: string): ApiAppConfig {
  return {
    pi: {
      command: "pi",
      packageManifestPath: join(dataDir, "pi-packages.json"),
      sessionDir: join(dataDir, "pi-sessions"),
      tokenUsagePath: join(dataDir, "provider-usage", "tokens.jsonl"),
      extensionPaths: [],
      timeoutMs: 1_000,
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    paths: {
      dataDir,
      configDir: join(dataDir, "config"),
      privateConfigDir: join(dataDir, "config"),
      configDirs: [join(dataDir, "config")],
      eventsRoot: join(dataDir, "events"),
      remindersRoot: join(dataDir, "reminders"),
      feedbackRoot: join(dataDir, "feedback"),
      skillsRoot: join(dataDir, "skills"),
    },
    api: {
      host: "127.0.0.1",
      port: 0,
      tokensPath: join(dataDir, "config", "api-tokens.json"),
      pairingsPath: join(dataDir, "config", "api-pairings.json"),
    },
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  console.error(`${label}: expected a non-empty string`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

await verifyApiBot();

console.log("API bot verification passed");
