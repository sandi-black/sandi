import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentStore, AttachmentTooLargeError } from "./store";

// Exercises the content-addressed store directly (hashing, dedup, identity
// scoping, the size cap, name/mime fill-in) plus the on-disk shape the atomic
// rename produces. `upload` takes a real IncomingMessage, so a tiny loopback
// HTTP server stands in for the request body rather than a hand-built stream:
// this is a genuine Node request object, not a shape approximation.

async function verifyAttachmentStore(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sandi-attachment-store-"));
  const server = createServer();
  const uploads: { body: IncomingMessage; done: () => void }[] = [];
  server.on("request", (request, response) => {
    // Held open until the test explicitly signals the handler is done reading
    // the body, so a single server can serve many uploads across the test.
    const waiter = new Promise<void>((resolveWaiter) => {
      uploads.push({ body: request, done: resolveWaiter });
    });
    void waiter.then(() => {
      // Each request here is a one-shot upload; telling the client to close
      // rather than keep the socket alive means it is not left open (and
      // holding this script's event loop) once the response finishes.
      response.writeHead(200, { connection: "close" }).end();
    });
  });
  const port = await listen(server);

  try {
    const store = new AttachmentStore(root);

    await verifyBasicUploadAndOwnedRead(store, port, uploads);
    await verifyIdentityScopedRead(store, port, uploads);
    await verifyDedup(store, port, uploads);
    await verifyDedupRestoresMissingBlob(store, root, port, uploads);
    await verifySizeCapAborts(store, port, uploads);
    await verifyAtomicLayout(store, root, port, uploads);
    await verifyUnknownHashIsUndefined(store);

    console.log("attachment store verification passed");
  } finally {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    await rm(root, { recursive: true, force: true });
  }
}

// Posts a body to the loopback server and hands the resulting IncomingMessage
// to the store's upload(), settling the server's response once upload()
// finishes reading it.
async function uploadBytes(
  store: AttachmentStore,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
  input: {
    bytes: Buffer;
    mimeType: string;
    name: string;
    identityId: string;
    maxBytes?: number;
  },
): ReturnType<AttachmentStore["upload"]> {
  const clientDone = postBytes(port, input.bytes);
  // The request handler above records the body as soon as headers land, which
  // happens before the client's fetch settles; poll the queue rather than race
  // it against the fetch promise.
  const requestRecord = await waitForNextUpload(uploads);
  try {
    return await store.upload({
      body: requestRecord.body,
      mimeType: input.mimeType,
      name: input.name,
      identityId: input.identityId,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    });
  } finally {
    // Settle the server's response (and let the client's request resolve or
    // error out) even when upload() throws, e.g. the size-cap case, which
    // destroys the body stream without the store itself ever answering the
    // request. Without this, that socket never completes and server.close()
    // in the caller's cleanup would wait for it forever.
    requestRecord.done();
    await clientDone.catch(() => {});
  }
}

function postBytes(port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolvePost, rejectPost) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        headers: {
          "content-length": bytes.length,
          connection: "close",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolvePost());
        res.on("error", rejectPost);
      },
    );
    req.on("error", rejectPost);
    req.end(bytes);
  });
}

function waitForNextUpload(
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<{ body: IncomingMessage; done: () => void }> {
  return new Promise((resolveNext) => {
    const poll = (): void => {
      const next = uploads.shift();
      if (next) {
        resolveNext(next);
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function verifyBasicUploadAndOwnedRead(
  store: AttachmentStore,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const bytes = Buffer.from("Grace Hopper's compiler notes", "utf8");
  const result = await uploadBytes(store, port, uploads, {
    bytes,
    mimeType: "text/plain-not-really-checked-here",
    name: "notes.txt",
    identityId: "grace",
  });
  // The store does not itself validate the mime against the supported set
  // (upload-route.ts does that at the HTTP boundary); it stores whatever it is
  // told, so this fixture uses a made-up type deliberately.
  assertEqual(result.hash.length, 64, "the returned hash is 64 hex chars");
  assertEqual(result.size, bytes.length, "the returned size matches the body");
  assertEqual(
    result.name,
    "notes.txt",
    "the returned name is the uploaded name",
  );

  const read = await store.get(result.hash, "grace");
  if (!read) {
    throw new Error("expected the uploader to read back its own upload");
  }
  assertEqual(
    read.metadata.name,
    "notes.txt",
    "read-back metadata carries the name",
  );
  const onDisk = await readFile(read.path);
  assertEqual(
    onDisk.toString("utf8"),
    bytes.toString("utf8"),
    "the blob on disk matches the uploaded bytes",
  );
  console.log("ok an upload round-trips through get() for its own uploader");
}

async function verifyIdentityScopedRead(
  store: AttachmentStore,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const result = await uploadBytes(store, port, uploads, {
    bytes: Buffer.from("Ada Lovelace's notes on the Analytical Engine"),
    mimeType: "text/plain",
    name: "ada-notes.txt",
    identityId: "ada",
  });
  const strangerRead = await store.get(result.hash, "someone-else");
  assertEqual(
    strangerRead,
    undefined,
    "a non-owner reading a real hash gets undefined, indistinguishable from unknown",
  );
  console.log(
    "ok get() is identity-scoped: a non-owner sees no such attachment",
  );
}

async function verifyDedup(
  store: AttachmentStore,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const bytes = Buffer.from("Anna Winlock's star catalog computations");
  const first = await uploadBytes(store, port, uploads, {
    bytes,
    mimeType: "text/plain",
    name: "catalog.txt",
    identityId: "anna",
  });
  const second = await uploadBytes(store, port, uploads, {
    bytes,
    mimeType: "text/plain",
    name: "catalog-again.txt",
    identityId: "hopper-2",
  });
  assertEqual(
    second.hash,
    first.hash,
    "identical bytes hash to the same digest",
  );
  assertEqual(
    second.name,
    "catalog.txt",
    "dedup keeps the first-seen name rather than the second uploader's name",
  );

  // Both uploaders can now read it back; a third identity still cannot.
  const ownerRead = await store.get(first.hash, "anna");
  const secondOwnerRead = await store.get(first.hash, "hopper-2");
  const strangerRead = await store.get(first.hash, "nobody");
  if (!ownerRead || !secondOwnerRead) {
    throw new Error("expected both uploaders to own the deduped attachment");
  }
  assertEqual(
    strangerRead,
    undefined,
    "a dedup upload does not grant ownership to anyone but the two uploaders",
  );
  console.log(
    "ok re-uploading identical bytes dedups storage and adds the new uploader as an owner",
  );
}

// A stale sidecar whose blob has vanished must not turn a re-upload into a
// success-that-cannot-be-read: the dedup branch checks the disk and restores
// the blob from the fresh upload instead of discarding it.
async function verifyDedupRestoresMissingBlob(
  store: AttachmentStore,
  root: string,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const bytes = Buffer.from("Grace Hopper's compiler notes, second copy");
  const first = await uploadBytes(store, port, uploads, {
    bytes,
    mimeType: "text/plain",
    name: "notes.txt",
    identityId: "hopper",
  });
  const blobPath = join(root, first.hash.slice(0, 2), first.hash);
  await rm(blobPath, { force: true });

  const second = await uploadBytes(store, port, uploads, {
    bytes,
    mimeType: "text/plain",
    name: "notes-again.txt",
    identityId: "hopper",
  });
  assertEqual(second.hash, first.hash, "the restore reports the same digest");
  const restored = await readFile(blobPath);
  if (!restored.equals(bytes)) {
    throw new Error("expected the re-upload to restore the missing blob");
  }
  const readBack = await store.get(first.hash, "hopper");
  if (!readBack) {
    throw new Error("expected the restored attachment to read back");
  }
  console.log(
    "ok a dedup upload restores a blob that vanished out from under its sidecar",
  );
}

async function verifySizeCapAborts(
  store: AttachmentStore,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const bytes = randomBytes(1024);
  let threw = false;
  try {
    await uploadBytes(store, port, uploads, {
      bytes,
      mimeType: "application/octet-stream",
      name: "too-big.bin",
      identityId: "grace",
      maxBytes: 100,
    });
  } catch (error) {
    threw = error instanceof AttachmentTooLargeError;
  }
  assertEqual(threw, true, "exceeding the cap throws AttachmentTooLargeError");
  console.log(
    "ok an upload over the size cap aborts with AttachmentTooLargeError",
  );
}

async function verifyAtomicLayout(
  store: AttachmentStore,
  root: string,
  port: number,
  uploads: { body: IncomingMessage; done: () => void }[],
): Promise<void> {
  const result = await uploadBytes(store, port, uploads, {
    bytes: Buffer.from("Sandi attachment layout check"),
    mimeType: "text/plain",
    name: "layout.txt",
    identityId: "grace",
  });
  const shard = result.hash.slice(0, 2);
  const blobPath = join(root, shard, result.hash);
  const sidecarPath = join(root, shard, `${result.hash}.json`);
  const blobStat = await stat(blobPath);
  assertEqual(
    blobStat.isFile(),
    true,
    "the blob is placed at attachments/<shard>/<hash>",
  );
  const sidecar: unknown = JSON.parse(await readFile(sidecarPath, "utf8"));
  if (!isRecord(sidecar)) throw new Error("sidecar metadata is not an object");
  assertEqual(
    sidecar["hash"],
    result.hash,
    "the sidecar records the same hash",
  );
  assertEqual(
    Array.isArray(sidecar["ownerIdentityIds"])
      ? sidecar["ownerIdentityIds"][0]
      : undefined,
    "grace",
    "the sidecar records the uploader as an owner",
  );
  console.log(
    "ok the blob and its sidecar land at the expected content-addressed path",
  );
}

async function verifyUnknownHashIsUndefined(
  store: AttachmentStore,
): Promise<void> {
  const madeUpHash = "f".repeat(64);
  const result = await store.get(madeUpHash, "anyone");
  assertEqual(
    result,
    undefined,
    "a well-formed but unknown hash yields undefined",
  );
  const malformed = await store.get("not-a-hash", "anyone");
  assertEqual(
    malformed,
    undefined,
    "a malformed hash yields undefined without touching disk",
  );
  console.log("ok get() returns undefined for an unknown or malformed hash");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind a TCP port");
      }
      resolveListen(address.port);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  console.error(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
  process.exit(1);
}

await verifyAttachmentStore();
