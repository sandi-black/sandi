import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAttachmentStaging } from "./attachment-staging";
import { createTurnPipeline } from "./turn-pipeline";
import { AttachmentStore } from "@sandi-server/surfaces/api/attachments/store";
import { handleAttachmentUpload } from "@sandi-server/surfaces/api/attachments/upload-route";

// End-to-end check of the app's submit pipeline against the server's real
// attachment route code, in-process: a staged image uploads to the real
// AttachmentStore through the real upload handler and the turn body references
// its hash, while a staged plain file skips upload entirely and rides as a
// desktop path in the message text. This is the wire-agreement test between
// app/ and src/ (headers, response shape, turn body), without Electron and
// without a full api-bot.
// Run with: npm run verify:turn-pipeline -w app

const TOKEN = "ab".repeat(32);

type SeenUpload = {
  authorization: string | undefined;
  contentType: string | undefined;
  name: string | undefined;
};

type SeenTurn = {
  authorization: string | undefined;
  path: string;
  body: unknown;
};

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "sandi-verify-pipeline-"));
  try {
    const store = new AttachmentStore(join(scratch, "attachments"));
    const uploads: SeenUpload[] = [];
    const turns: SeenTurn[] = [];

    const server = createServer((request, response) => {
      void (async () => {
        const path = request.url ?? "/";
        if (request.method === "POST" && path === "/v1/attachments") {
          uploads.push({
            authorization: headerValue(request, "authorization"),
            contentType: headerValue(request, "content-type"),
            name: headerValue(request, "x-sandi-name"),
          });
          // One name resolves later than the rest, so the multi-image case
          // below can prove refs keeps the images' declared order rather than
          // their completion order.
          if (headerValue(request, "x-sandi-name") === "slow.png") {
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          await handleAttachmentUpload(request, response, {
            store,
            identityId: "hopper",
          });
          return;
        }
        if (request.method === "POST" && path.endsWith("/turns")) {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          }
          turns.push({
            authorization: headerValue(request, "authorization"),
            path,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              conversationId: "desktop-grace",
              text: "I looked at both.",
            }),
          );
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      })();
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not report a port");
    }
    const url = `http://127.0.0.1:${address.port}`;

    // The pipeline reads credentials from disk on every send;
    // SANDI_DESKTOP_CONFIG points it at this test's own pairing.
    const configPath = join(scratch, "desktop.json");
    await writeFile(
      configPath,
      JSON.stringify({
        url,
        token: TOKEN,
        deviceId: "verify-device",
        identityId: "hopper",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    process.env["SANDI_DESKTOP_CONFIG"] = configPath;

    // One image (uploads) and one plain file (rides as a path).
    const imageBytes = Buffer.from("not a real png, hashed all the same");
    const imagePath = join(scratch, "ada-plot.png");
    await writeFile(imagePath, imageBytes);
    const notesPath = join(scratch, "winlock-notes.txt");
    await writeFile(notesPath, "orbit tables", "utf8");

    const staging = createAttachmentStaging(join(scratch, "staging"));
    const stagedImage = await staging.stagePath(imagePath);
    const stagedNotes = await staging.stagePath(notesPath);
    assert.ok(stagedImage && stagedNotes, "both files staged");
    assert.equal(stagedImage.kind, "image", "png stages as an image");
    assert.equal(stagedNotes.kind, "file", "txt stages as a plain file");

    const pipeline = createTurnPipeline({ staging });
    const outcome = await pipeline({
      conversationId: "desktop-grace",
      text: "Compare the plot with the notes.",
      turnId: "turn-1",
      attachmentIds: [stagedImage.id, stagedNotes.id],
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      outcome,
      { ok: true, conversationId: "desktop-grace", text: "I looked at both." },
      "turn settles with the server's reply",
    );

    // The image went through the real upload route with the agreed headers.
    assert.equal(uploads.length, 1, "exactly one upload: the image");
    const upload = uploads[0];
    assert.ok(upload, "upload recorded");
    assert.equal(upload.authorization, `Bearer ${TOKEN}`);
    assert.equal(upload.contentType, "image/png");
    assert.equal(upload.name, "ada-plot.png");

    // The turn body references the blob by its true content hash, and the
    // store can hand the bytes back to their owner (and only their owner).
    const expectedHash = createHash("sha256").update(imageBytes).digest("hex");
    assert.equal(turns.length, 1, "exactly one turn posted");
    const turn = turns[0];
    assert.ok(turn, "turn recorded");
    assert.equal(turn.authorization, `Bearer ${TOKEN}`);
    assert.ok(
      turn.path.includes("/v1/conversations/desktop-grace/"),
      "turn posted to the conversation",
    );
    const body = turn.body;
    assert.ok(body && typeof body === "object", "turn body is an object");
    const record: Partial<Record<string, unknown>> = { ...body };
    assert.deepEqual(
      record["attachments"],
      [{ hash: expectedHash, name: "ada-plot.png" }],
      "turn references the uploaded image by hash",
    );
    const input = record["input"];
    assert.ok(typeof input === "string", "turn input is a string");
    assert.ok(
      input.startsWith("Compare the plot with the notes."),
      "the human's text leads the input",
    );
    assert.ok(
      input.includes(notesPath),
      "the plain file rides as a desktop path",
    );
    const stored = await store.get(expectedHash, "hopper");
    assert.ok(stored, "the blob landed in the store for its owner");
    assert.equal(
      await store.get(expectedHash, "lovelace"),
      undefined,
      "another identity cannot read it",
    );

    // Two images uploaded in parallel (see turn-pipeline.ts): staged slow
    // first, fast second, but the slow one's response is delayed on the wire
    // so it lands second. refs must still come back in the images' declared
    // order, proving Promise.all's ordering guarantee rather than whichever
    // upload happens to finish first.
    const slowBytes = Buffer.from("slow to upload, first in the list");
    const slowPath = join(scratch, "slow.png");
    await writeFile(slowPath, slowBytes);
    const fastBytes = Buffer.from("fast to upload, second in the list");
    const fastPath = join(scratch, "fast.png");
    await writeFile(fastPath, fastBytes);
    const stagedSlow = await staging.stagePath(slowPath);
    const stagedFast = await staging.stagePath(fastPath);
    assert.ok(stagedSlow && stagedFast, "both images staged");

    const multiOutcome = await pipeline({
      conversationId: "desktop-grace",
      text: "Compare these two plots.",
      turnId: "turn-2",
      attachmentIds: [stagedSlow.id, stagedFast.id],
      signal: new AbortController().signal,
    });
    assert.equal(multiOutcome.ok, true, "multi-image turn settles");
    assert.equal(turns.length, 2, "the multi-image turn posted");
    const multiTurn = turns[1];
    assert.ok(multiTurn, "multi-image turn recorded");
    const multiBody = multiTurn.body;
    assert.ok(
      multiBody && typeof multiBody === "object",
      "multi-image turn body is an object",
    );
    const multiRecord: Partial<Record<string, unknown>> = { ...multiBody };
    const slowHash = createHash("sha256").update(slowBytes).digest("hex");
    const fastHash = createHash("sha256").update(fastBytes).digest("hex");
    assert.deepEqual(
      multiRecord["attachments"],
      [
        { hash: slowHash, name: "slow.png" },
        { hash: fastHash, name: "fast.png" },
      ],
      "refs keep the images' declared order even though the slow upload resolves last",
    );

    // Unpaired: a missing credentials file fails the send with a clear error,
    // touching neither route.
    process.env["SANDI_DESKTOP_CONFIG"] = join(scratch, "missing.json");
    const unpaired = await pipeline({
      conversationId: "desktop-grace",
      text: "hello?",
      turnId: "turn-3",
      attachmentIds: [],
      signal: new AbortController().signal,
    });
    assert.equal(unpaired.ok, false, "unpaired send fails");
    assert.ok(
      !unpaired.ok && unpaired.error.includes("not paired"),
      "the error names pairing",
    );
    assert.equal(turns.length, 2, "no turn reached the server unpaired");

    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    console.log("verify-turn-pipeline: ok");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

void main();
