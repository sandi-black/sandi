import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assert, assertEqual } from "@/lib/verification/harness";
import { executeLocalTool } from "@/surfaces/api/client/executors";
import {
  DesktopFileAttachmentSchema,
  MAX_DESKTOP_FILE_TRANSFER_BYTES,
} from "@/surfaces/api/devices/desktop-file-transfer";

export async function verifyDesktopFileTransfer(
  rootDir: string,
): Promise<void> {
  const path = join(rootDir, "grace-notes.txt");
  await writeFile(path, "COBOL notes", "utf8");
  const transferred = await executeLocalTool(
    {
      tool: "local_transfer_file",
      params: { path, name: "grace-notes.txt" },
    },
    { rootDir },
  );
  assert(transferred.ok, `file transfer should succeed: ${transferred.error}`);
  assert(
    DesktopFileAttachmentSchema.safeParse(transferred.attachment).success,
    "the transfer returns a validated attachment envelope",
  );
  assertEqual(
    transferred.attachment?.mimeType,
    "text/plain",
    "the desktop infers a conservative MIME type from the extension",
  );
  assertEqual(
    Buffer.from(transferred.attachment?.dataBase64 ?? "", "base64").toString(
      "utf8",
    ),
    "COBOL notes",
    "the transfer preserves every file byte",
  );

  const oversized = join(rootDir, "oversized.bin");
  await writeFile(oversized, Buffer.alloc(MAX_DESKTOP_FILE_TRANSFER_BYTES + 1));
  const rejected = await executeLocalTool(
    { tool: "local_transfer_file", params: { path: oversized } },
    { rootDir },
  );
  assert(
    !rejected.ok && (rejected.error ?? "").includes("transfer limit"),
    "an oversized file is refused before its bytes are returned",
  );

  const controller = new AbortController();
  controller.abort(new Error("turn cancelled"));
  const cancelled = await executeLocalTool(
    { tool: "local_transfer_file", params: { path } },
    { rootDir },
    controller.signal,
  );
  assert(!cancelled.ok, "a cancelled transfer does not read the file");
  console.log(
    "ok desktop file transfer is byte-precise, bounded, and cancellable",
  );
}
