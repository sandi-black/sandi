import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createAttachmentStaging,
  MAX_ATTACHMENTS_PER_TURN,
} from "./attachment-staging";

const root = await mkdtemp(join(tmpdir(), "sandi-attachment-staging-"));
try {
  const source = join(root, "notes.txt");
  await writeFile(source, "Ada Lovelace");
  const staging = createAttachmentStaging(join(root, "pasted"));

  const concurrent = await Promise.all(
    Array.from({ length: MAX_ATTACHMENTS_PER_TURN * 2 }, () =>
      staging.stagePath(source),
    ),
  );
  const accepted = concurrent.filter((attachment) => attachment !== null);
  assert.equal(
    accepted.length,
    MAX_ATTACHMENTS_PER_TURN,
    "concurrent staging cannot overrun the attachment cap",
  );
  assert.equal(
    staging.take(accepted.map((attachment) => attachment.id)).length,
    MAX_ATTACHMENTS_PER_TURN,
    "every accepted attachment remains available until submit",
  );
  assert.ok(
    await staging.stagePath(source),
    "consuming staged attachments releases capacity",
  );

  const pasted = createAttachmentStaging(join(root, "pasted"));
  const [first, second] = await Promise.all([
    pasted.stagePastedImage("data:image/png;base64,AA=="),
    pasted.stagePastedImage("data:image/png;base64,AA=="),
  ]);
  assert.ok(first && second, "valid pasted images stage concurrently");
  assert.notEqual(first.path, second.path, "pastes never overwrite each other");
  assert.match(
    basename(first.path),
    /^pasted-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
    "pasted filenames use collision-resistant UUIDs",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("verify-attachment-staging: ok");
