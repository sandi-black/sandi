import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PiConfig } from "@/lib/config/env";
import { PiCliClient } from "@/lib/provider/pi-cli-client";

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-pi-harness-"));
const fakePiModulePath = join(tempRoot, "fake-pi.mjs");
const fakePiPath =
  process.platform === "win32"
    ? join(tempRoot, "fake-pi.cmd")
    : fakePiModulePath;
const recordPath = join(tempRoot, "record.json");
const agentDir = join(tempRoot, "agent");
const packageDir = join(tempRoot, "packages");
const sessionDir = join(tempRoot, "sessions");
const extensionPath = join(tempRoot, "sandi-extension.ts");

try {
  await writeFile(
    fakePiModulePath,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  stdin += chunk;
}

await writeFile(
  process.env.FAKE_PI_RECORD_PATH,
  JSON.stringify(
    {
      args: process.argv.slice(2),
      stdin,
      env: {
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
        SANDI_CONVERSATION_ID: process.env.SANDI_CONVERSATION_ID,
        SANDI_SESSION_MODE: process.env.SANDI_SESSION_MODE,
      },
    },
    null,
    2,
  ),
  "utf8",
);
process.stdout.write("fake model output\\n");
`,
    "utf8",
  );
  if (process.platform === "win32") {
    await writeFile(
      fakePiPath,
      `@echo off\r\n"${process.execPath}" "${fakePiModulePath}" %*\r\n`,
      "utf8",
    );
  } else {
    await chmod(fakePiPath, 0o755);
  }
  process.env["FAKE_PI_RECORD_PATH"] = recordPath;

  const config: PiConfig = {
    command: fakePiPath,
    provider: "openai-codex",
    model: "gpt-5.5",
    thinking: "high",
    agentDir,
    packageDir,
    packageManifestPath: join(tempRoot, "pi-packages.json"),
    sessionDir,
    tokenUsagePath: join(tempRoot, "tokens.jsonl"),
    extensionPaths: [extensionPath],
    timeoutMs: 5000,
    eventsRoot: join(tempRoot, "events"),
    remindersRoot: join(tempRoot, "reminders"),
    skillsRoot: join(tempRoot, "skills"),
  };

  const response = await new PiCliClient(config).generateTurn({
    conversationId: "test-conversation",
    instructions: "system instructions",
    input: "hello from stdin",
    sessionMode: "persistent",
    memoryContext: {
      memoryRoot: join(tempRoot, "memory"),
      memoryScopes: [],
      participants: [],
    },
  });

  assert(
    response.text === "fake model output",
    "provider should return stdout",
  );
  const record = parseRecord(await readFile(recordPath, "utf8"));
  assert(
    !record.args.includes("--no-extensions"),
    "main Pi turns must leave extension discovery enabled for codex conversion",
  );
  assert(
    !record.args.includes("--no-builtin-tools"),
    "main Pi turns must leave native builtin tools enabled",
  );
  assert(
    record.args.includes("--extension") && record.args.includes(extensionPath),
    "main Pi turns should still load Sandi-owned extensions explicitly",
  );
  assert(
    record.args.includes("--append-system-prompt"),
    "main Pi turns should append the full system prompt from a payload file",
  );
  const promptPath = valueAfter(record.args, "--append-system-prompt");
  assert(
    promptPath !== undefined &&
      (await readFile(promptPath, "utf8")) === "system instructions",
    "system prompt payload should contain the compiled instructions",
  );
  assert(
    !record.args.includes("hello from stdin"),
    "user input should not be passed as an argv argument",
  );
  assert(
    record.stdin === "hello from stdin",
    "user input should be sent on stdin",
  );
  assert(
    record.env.PI_CODING_AGENT_DIR === agentDir,
    "turns should use the configured Pi agent dir",
  );
  assert(
    record.env.PI_PACKAGE_DIR === packageDir,
    "turns should use the configured Pi package dir",
  );
  assert(
    record.env.SANDI_CONVERSATION_ID === "test-conversation",
    "token usage metadata should include the conversation id",
  );
  assert(
    record.env.SANDI_SESSION_MODE === "persistent",
    "token usage metadata should include session mode",
  );

  console.log("Pi harness verification passed");
} finally {
  delete process.env["FAKE_PI_RECORD_PATH"];
  await rm(tempRoot, { recursive: true, force: true });
}

type FakePiRecord = {
  args: string[];
  stdin: string;
  env: {
    PI_CODING_AGENT_DIR?: string;
    PI_PACKAGE_DIR?: string;
    SANDI_CONVERSATION_ID?: string;
    SANDI_SESSION_MODE?: string;
  };
};

function parseRecord(raw: string): FakePiRecord {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("fake Pi record was not an object");
  const args = parsed["args"];
  const stdin = parsed["stdin"];
  const env = parsed["env"];
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    throw new Error("fake Pi record args were malformed");
  }
  if (typeof stdin !== "string") {
    throw new Error("fake Pi record stdin was malformed");
  }
  if (!isRecord(env)) throw new Error("fake Pi record env was malformed");
  const parsedEnv: FakePiRecord["env"] = {};
  assignOptionalString(parsedEnv, "PI_CODING_AGENT_DIR", env);
  assignOptionalString(parsedEnv, "PI_PACKAGE_DIR", env);
  assignOptionalString(parsedEnv, "SANDI_CONVERSATION_ID", env);
  assignOptionalString(parsedEnv, "SANDI_SESSION_MODE", env);
  return {
    args,
    stdin,
    env: parsedEnv,
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function assignOptionalString(
  target: FakePiRecord["env"],
  key: keyof FakePiRecord["env"],
  source: Record<string, unknown>,
): void {
  const value = optionalString(source[key]);
  if (value !== undefined) target[key] = value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
