import { chmod, writeFile } from "node:fs/promises";

export const PRIVATE_FILE_MODE = 0o600;

export async function writePrivateTextFile(
  path: string,
  content: string,
): Promise<void> {
  await writeFile(path, content, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await chmodPrivateFile(path);
}

export async function chmodPrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(path, PRIVATE_FILE_MODE);
}
