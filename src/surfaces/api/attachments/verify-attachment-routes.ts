import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContextCompiler } from "@/lib/context/context-compiler";
import { ConversationStore } from "@/lib/conversations/store";
import type {
  ModelProviderClient,
  ProviderProbe,
  ProviderTurnRequest,
  ProviderTurnResponse,
} from "@/lib/provider/pi-cli-client";
import {
  assert,
  assertEqual,
  isRecord,
  withTempDir,
} from "@/lib/verification/harness";
import { AttachmentRefsSchema } from "@/surfaces/api/attachments/turn-materialize";
import { ApiBot } from "@/surfaces/api/bot/api-bot";
import type { ApiAppConfig } from "@/surfaces/api/config";
import { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { ToolBroker } from "@/surfaces/api/devices/tool-broker";
import { API_SURFACE_CONTEXT } from "@/surfaces/api/runtime/context";

// Exercises the two attachment HTTP routes and the turn-body attachment refs
// against a real running ApiBot (see verify-api-bot.ts for the same boot
// pattern with fakes standing in for the provider and identity config).

const RAW_TOKEN =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "1".repeat(64);
const IDENTITY_ID = "hopper";
const OTHER_IDENTITY_ID = "lovelace";
const DEVICE_ID = "device-1";

async function verifyAttachmentRoutes(): Promise<void> {
  await withTempDir("sandi-attachment-routes-", async (dataDir) => {
    const provider = new RecordingProvider();
    const config = testConfig(dataDir);
    const devices = new DeviceRegistry();
    const broker = new ToolBroker(devices);
    const bot = new ApiBot({
      config,
      conversations: new ConversationStore(dataDir),
      contextCompiler: new ContextCompiler(
        config.paths.configDirs,
        config.paths.dataDir,
        API_SURFACE_CONTEXT,
      ),
      provider,
      devices,
      broker,
    });

    try {
      await writeFixtures(dataDir);
      await broker.start();
      await bot.start();
      const port = bot.address()?.port;
      if (!port) throw new Error("API bot did not expose a listening port");
      const base = `http://127.0.0.1:${port}`;

      await verifyUploadRequiresAuth(base);
      const uploaded = await verifyUploadAndDownloadRoundTrip(base);
      await verifyDownloadOfUnownedIsNotFound(base, uploaded.hash);
      await verifyDownloadOfUnknownIsNotFound(base);
      await verifyDownloadOfMissingBlobFailsClosed(base, dataDir);
      await verifyUploadRejectsBadNameAndMime(base);
      await verifyUploadRejectsOverCap(base);
      await verifyUploadRejectsQuota(base);
      await verifyTurnWithAttachmentsMaterializesFiles(base, provider, dataDir);
      await verifyTurnWithBadAttachmentRefIsRejected(base, provider);
      await verifyTurnAttachmentBounds(base, provider, dataDir);

      console.log("attachment routes verification passed");
    } finally {
      bot.stop();
      devices.closeAll();
      broker.stop();
    }
  });
}

async function verifyUploadRequiresAuth(base: string): Promise<void> {
  const response = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-sandi-name": "x.png" },
    body: Buffer.from("nope"),
    duplex: "half",
  });
  assertEqual(response.status, 401, "upload without a bearer is 401");
  console.log("ok POST /v1/attachments without a bearer returns 401");
}

async function verifyUploadAndDownloadRoundTrip(
  base: string,
): Promise<{ hash: string }> {
  const bytes = pngFixtureBytes();
  const uploadResponse = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "image/png",
      "x-sandi-name": "diagram.png",
    },
    body: bytes,
    duplex: "half",
  });
  assertEqual(uploadResponse.status, 200, "a well-formed upload returns 200");
  const uploadBody = await uploadResponse.json();
  if (!isRecord(uploadBody))
    throw new Error("upload response is not an object");
  const hash = uploadBody["hash"];
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("upload response did not carry a well-formed hash");
  }
  assertEqual(uploadBody["size"], bytes.length, "upload response carries size");
  assertEqual(
    uploadBody["mimeType"],
    "image/png",
    "upload response carries mimeType",
  );
  assertEqual(
    uploadBody["name"],
    "diagram.png",
    "upload response carries name",
  );
  console.log("ok POST /v1/attachments stores a well-formed upload");

  const downloadResponse = await fetch(`${base}/v1/attachments/${hash}`, {
    headers: { authorization: `Bearer ${RAW_TOKEN}` },
  });
  assertEqual(
    downloadResponse.status,
    200,
    "the uploader can download it back",
  );
  assertEqual(
    downloadResponse.headers.get("content-type"),
    "image/png",
    "the download carries the stored content-type",
  );
  const disposition = downloadResponse.headers.get("content-disposition") ?? "";
  assert(
    disposition.includes("diagram.png"),
    "the download's content-disposition names the stored filename",
  );
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  assertEqual(
    downloaded.toString("hex"),
    bytes.toString("hex"),
    "the downloaded bytes match the uploaded bytes",
  );
  console.log(
    "ok GET /v1/attachments/:hash streams the blob back with its stored metadata",
  );

  const noAuthDownload = await fetch(`${base}/v1/attachments/${hash}`);
  assertEqual(noAuthDownload.status, 401, "download without a bearer is 401");
  console.log("ok GET /v1/attachments/:hash without a bearer returns 401");

  return { hash };
}

async function verifyDownloadOfUnownedIsNotFound(
  base: string,
  hash: string,
): Promise<void> {
  const response = await fetch(`${base}/v1/attachments/${hash}`, {
    headers: { authorization: `Bearer ${OTHER_TOKEN}` },
  });
  assertEqual(
    response.status,
    404,
    "a real hash not owned by the caller is 404, same as unknown",
  );
  console.log(
    "ok GET /v1/attachments/:hash for a hash the caller does not own returns 404",
  );
}

async function verifyDownloadOfUnknownIsNotFound(base: string): Promise<void> {
  const response = await fetch(`${base}/v1/attachments/${"a".repeat(64)}`, {
    headers: { authorization: `Bearer ${RAW_TOKEN}` },
  });
  assertEqual(response.status, 404, "an unknown hash is 404");
  console.log("ok GET /v1/attachments/:hash for an unknown hash returns 404");
}

// A sidecar whose blob has gone missing is a server-side inconsistency; the
// download must fail closed as a 404 JSON error before success headers commit,
// never a 200 with a broken body.
async function verifyDownloadOfMissingBlobFailsClosed(
  base: string,
  dataDir: string,
): Promise<void> {
  const bytes = Buffer.from("blob that will vanish", "utf8");
  const upload = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "application/octet-stream",
      "x-sandi-name": "vanishing.bin",
    },
    body: bytes,
    duplex: "half",
  });
  assertEqual(upload.status, 200, "the vanishing blob uploads first");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await rm(join(dataDir, "attachments", hash.slice(0, 2), hash), {
    force: true,
  });

  const response = await fetch(`${base}/v1/attachments/${hash}`, {
    headers: { authorization: `Bearer ${RAW_TOKEN}` },
  });
  assertEqual(response.status, 404, "a sidecar without its blob is 404");
  console.log(
    "ok GET /v1/attachments/:hash whose blob is missing fails closed with 404",
  );
}

async function verifyUploadRejectsBadNameAndMime(base: string): Promise<void> {
  const badMime = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "application/x-not-supported",
      "x-sandi-name": "x.bin",
    },
    body: Buffer.from("x"),
    duplex: "half",
  });
  assertEqual(badMime.status, 400, "an unsupported mime type is 400");
  const badMimeBody = await badMime.json();
  assertEqual(
    isRecord(badMimeBody) && badMimeBody["error"],
    "invalid_mime",
    "an unsupported mime type answers invalid_mime",
  );

  const noName = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "image/png",
    },
    body: Buffer.from("x"),
    duplex: "half",
  });
  assertEqual(noName.status, 400, "a missing name header is 400");
  const noNameBody = await noName.json();
  assertEqual(
    isRecord(noNameBody) && noNameBody["error"],
    "invalid_name",
    "a missing name header answers invalid_name",
  );

  const traversalName = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "image/png",
      "x-sandi-name": "../escape.png",
    },
    body: Buffer.from("x"),
    duplex: "half",
  });
  assertEqual(
    traversalName.status,
    400,
    "a name carrying a path separator is 400",
  );
  console.log(
    "ok POST /v1/attachments rejects an unsupported mime, a missing name, and a path-separator name",
  );
}

async function verifyUploadRejectsOverCap(base: string): Promise<void> {
  // Exercises the route's real 64 MiB cap end to end (the store enforces it
  // while streaming, not after buffering), rather than a smaller stand-in cap:
  // the route does not expose a way to override it per-request, and the point
  // of this case is that the real cap is wired through to a 413.
  const overCapBytes = Buffer.alloc(64 * 1024 * 1024 + 1024, 1);
  const response = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "application/octet-stream",
      "x-sandi-name": "huge.bin",
    },
    body: overCapBytes,
    duplex: "half",
  });
  assertEqual(
    response.status,
    413,
    "an upload over the 64 MiB cap returns 413",
  );
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["error"],
    "too_large",
    "an over-cap upload answers too_large",
  );
  console.log("ok POST /v1/attachments over the size cap returns 413");
}

async function verifyUploadRejectsQuota(base: string): Promise<void> {
  const response = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "application/octet-stream",
      "x-sandi-name": "quota.bin",
    },
    body: Buffer.alloc(1_024, 7),
    duplex: "half",
  });
  assertEqual(response.status, 413, "an identity quota overflow returns 413");
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["error"],
    "quota_exceeded",
    "a quota overflow has a distinct error",
  );
  console.log("ok POST /v1/attachments reports identity quota exhaustion");
}

async function verifyTurnWithAttachmentsMaterializesFiles(
  base: string,
  provider: RecordingProvider,
  dataDir: string,
): Promise<void> {
  const bytes = pngFixtureBytes();
  const uploadResponse = await fetch(`${base}/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RAW_TOKEN}`,
      "content-type": "image/png",
      "x-sandi-name": "for-turn.png",
    },
    body: bytes,
    duplex: "half",
  });
  const uploadBody = await uploadResponse.json();
  const hash = isRecord(uploadBody) ? uploadBody["hash"] : undefined;
  if (typeof hash !== "string") throw new Error("upload did not return a hash");

  let observedDir: string | undefined;
  provider.onGenerateTurn = (request) => {
    const paths = request.attachmentPaths ?? [];
    observedDir = paths[0] ? dirnameOf(paths[0]) : undefined;
  };

  const response = await fetch(
    `${base}/v1/conversations/${encodeURIComponent("attachment-session")}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RAW_TOKEN}`,
      },
      body: JSON.stringify({
        input: "look at this diagram",
        attachments: [{ hash, name: "renamed.png" }],
      }),
    },
  );
  assertEqual(
    response.status,
    200,
    "a turn with a valid attachment ref returns 200",
  );

  const request = provider.lastRequest;
  if (!request) throw new Error("provider received no request");
  const paths = request.attachmentPaths ?? [];
  assertEqual(
    paths.length,
    1,
    "the provider request carries one attachment path",
  );
  const materializedPath = paths[0];
  if (!materializedPath) throw new Error("no materialized path recorded");
  assert(
    materializedPath.endsWith("renamed.png"),
    "the materialized file is named after the ref's override name",
  );

  // The temp dir is removed in the handler's finally, which the handler awaits
  // before its promise settles; but the HTTP response is written (and the
  // client's fetch can resolve) slightly before that finally completes, so
  // poll briefly rather than assume the two are simultaneous.
  const dirToCheck = observedDir;
  if (dirToCheck) {
    const stillExists = await pollUntil(
      () => dirExists(dirToCheck),
      (exists) => exists === false,
      2_000,
    );
    assertEqual(
      stillExists,
      false,
      "the per-turn attachment temp dir is removed after the turn finishes",
    );
  }
  const conversation = (await new ConversationStore(dataDir).list()).find(
    (manifest) => manifest.canonicalId.endsWith(":attachment-session"),
  );
  assert(
    conversation?.attachmentHashes?.includes(hash) === true,
    "the retained conversation records its attachment reference",
  );
  console.log(
    "ok a turn body with attachment refs materializes files under a sanitized name and cleans up afterward",
  );
}

async function verifyTurnAttachmentBounds(
  base: string,
  provider: RecordingProvider,
  dataDir: string,
): Promise<void> {
  assert(
    AttachmentRefsSchema.safeParse(
      Array.from({ length: 16 }, (_, index) => ({
        hash: createHash("sha256").update(`boundary-${index}`).digest("hex"),
      })),
    ).success,
    "exactly 16 attachment refs pass boundary parsing",
  );
  const hashes: string[] = [];
  for (const label of ["one", "two", "three"]) {
    const hash = createHash("sha256")
      .update(`aggregate-${label}`)
      .digest("hex");
    hashes.push(hash);
    const dir = join(dataDir, "attachments", hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, hash), label);
    await writeFile(
      join(dir, `${hash}.json`),
      `${JSON.stringify({
        hash,
        size: 64 * 1024 * 1024,
        mimeType: "application/octet-stream",
        name: `${label}.bin`,
        ownerIdentityIds: [IDENTITY_ID],
        createdAt: "2026-07-11T00:00:00.000Z",
      })}\n`,
    );
  }

  const beforeBoundary = provider.callCount;
  const boundary = await postTurnWithHashes(
    base,
    "aggregate-boundary",
    hashes.slice(0, 2),
  );
  assertEqual(
    boundary.status,
    200,
    "exactly 128 MiB of attachment metadata is accepted",
  );
  assertEqual(
    provider.callCount,
    beforeBoundary + 1,
    "the boundary turn reaches the provider",
  );

  const beforeOverflow = provider.callCount;
  const overflow = await postTurnWithHashes(base, "aggregate-overflow", hashes);
  assertEqual(
    overflow.status,
    413,
    "aggregate attachment data over 128 MiB is rejected",
  );
  const overflowBody = await overflow.json();
  assertEqual(
    isRecord(overflowBody) && overflowBody["error"],
    "attachments_too_large",
    "aggregate overflow has a distinct error",
  );
  assertEqual(
    provider.callCount,
    beforeOverflow,
    "aggregate overflow is rejected before provider work",
  );

  const tooMany = await postTurnWithHashes(
    base,
    "attachment-count-overflow",
    Array.from({ length: 17 }, (_, index) =>
      createHash("sha256").update(`missing-${index}`).digest("hex"),
    ),
  );
  assertEqual(tooMany.status, 400, "more than 16 attachment refs is rejected");
  assertEqual(
    provider.callCount,
    beforeOverflow,
    "count overflow is rejected before provider work",
  );
  console.log(
    "ok per-turn attachment count and aggregate byte boundaries are enforced",
  );
}

function postTurnWithHashes(
  base: string,
  conversationId: string,
  hashes: readonly string[],
): Promise<Response> {
  return fetch(
    `${base}/v1/conversations/${encodeURIComponent(conversationId)}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RAW_TOKEN}`,
      },
      body: JSON.stringify({
        input: "inspect these attachments",
        attachments: hashes.map((hash) => ({ hash })),
      }),
    },
  );
}

async function verifyTurnWithBadAttachmentRefIsRejected(
  base: string,
  provider: RecordingProvider,
): Promise<void> {
  const before = provider.callCount;
  const badHash = "b".repeat(64);
  const response = await fetch(
    `${base}/v1/conversations/${encodeURIComponent("attachment-session-bad")}/turns`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RAW_TOKEN}`,
      },
      body: JSON.stringify({
        input: "look at this",
        attachments: [{ hash: badHash }],
      }),
    },
  );
  assertEqual(
    response.status,
    400,
    "a turn referencing an unowned hash is 400",
  );
  const body = await response.json();
  assertEqual(
    isRecord(body) && body["error"],
    "invalid_attachment",
    "the error code is invalid_attachment",
  );
  assertEqual(
    isRecord(body) && body["hash"],
    badHash,
    "the response names the offending hash",
  );
  assertEqual(
    provider.callCount,
    before,
    "the provider is never invoked for a turn with an invalid attachment ref",
  );
  console.log(
    "ok a turn body referencing an unowned or unknown attachment hash returns 400 without running the provider",
  );
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

// Polls `check` every 20ms until `satisfied` accepts its result or the budget
// runs out, returning whatever the last call produced. Used only for a
// server-side side effect (temp-dir cleanup) that finishes a moment after the
// HTTP response it accompanies, not for anything that might hang indefinitely.
async function pollUntil<T>(
  check: () => Promise<T>,
  satisfied: (value: T) => boolean,
  budgetMs: number,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = await check();
  while (!satisfied(value) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    value = await check();
  }
  return value;
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(0, idx);
}

function pngFixtureBytes(): Buffer {
  // A minimal but well-formed PNG signature plus a little payload; the store
  // does not itself validate magic bytes (that is scoped to the desktop's
  // screenshot path in the device protocol), so any bytes exercise the route.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("not a real png payload, just fixture bytes"),
  ]);
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
            displayName: "Grace Hopper",
            platforms: { discord: { id: "111", username: "hopper" } },
          },
          {
            id: OTHER_IDENTITY_ID,
            displayName: "Ada Lovelace",
            platforms: { discord: { id: "222", username: "lovelace" } },
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
              .update(OTHER_TOKEN, "utf8")
              .digest("hex"),
            identityId: OTHER_IDENTITY_ID,
            deviceId: "device-2",
            label: "verify-other",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
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
      attachmentQuotaBytes: 1_024,
      attachmentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      attachmentCleanupIntervalMs: 24 * 60 * 60 * 1_000,
    },
  };
}

class RecordingProvider implements ModelProviderClient {
  readonly responseText = "Sandi reply from the fake provider.";
  lastRequest: ProviderTurnRequest | undefined;
  callCount = 0;
  onGenerateTurn: ((request: ProviderTurnRequest) => void) | undefined;

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
    this.onGenerateTurn?.(request);
    return {
      text: this.responseText,
      deliverySideEffects: false,
      signals: [],
      raw: null,
    };
  }
}

await verifyAttachmentRoutes();
