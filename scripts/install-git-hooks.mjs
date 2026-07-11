import { spawnSync } from "node:child_process";

const gitCheck = spawnSync("git", ["rev-parse", "--git-dir"], {
  stdio: "ignore",
  windowsHide: true,
});

if (gitCheck.status === 0) {
  const install = spawnSync(
    "git",
    ["config", "core.hooksPath", ".githooks"],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (install.error) {
    console.error(`Unable to configure Git hooks: ${install.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = install.status ?? 1;
  }
}
