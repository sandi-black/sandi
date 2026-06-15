import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GhCli, GhCliError } from "@/surfaces/github/github/gh-cli";

const workDir = await mkdtemp(join(tmpdir(), "sandi-gh-cli-"));

try {
  const command = join(workDir, "hang-gh");
  await writeFile(command, "#!/usr/bin/env bash\nsleep 10\n", "utf8");
  await chmod(command, 0o700);

  const gh = new GhCli({ command, timeoutMs: 100 });
  let timedOut = false;
  const startedAt = Date.now();
  try {
    await gh.apiText({ endpoint: "/user" });
  } catch (error) {
    if (
      error instanceof GhCliError &&
      error.stderr.includes("timed out after 100ms")
    ) {
      timedOut = true;
    } else {
      throw error;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  assert(timedOut, "gh command should time out");
  assert(
    elapsedMs < 1_000,
    `gh timeout should settle promptly; elapsed ${elapsedMs}ms`,
  );
  console.log("GitHub gh cli verification passed");
} finally {
  await rm(workDir, { recursive: true, force: true });
}

function assert(value: boolean, label: string): void {
  if (value) return;
  throw new Error(label);
}
