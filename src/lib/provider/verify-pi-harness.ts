import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PiConfig } from "@/lib/config/env";
import { PiCliClient } from "@/lib/provider/pi-cli-client";
import { assert, isRecord, withTempDir } from "@/lib/verification/harness";

await withTempDir("sandi-pi-harness-", async (tempRoot) => {
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
        SANDI_TOOL_BROKER_URL: process.env.SANDI_TOOL_BROKER_URL,
        SANDI_TOOL_BROKER_TOKEN: process.env.SANDI_TOOL_BROKER_TOKEN,
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
      feedbackRoot: join(tempRoot, "feedback"),
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
      "default (non-api) Pi turns must leave native builtin tools enabled",
    );
    assert(
      !record.args.includes("--exclude-tools"),
      "default turns must not exclude any tools",
    );
    assert(
      record.env.SANDI_TOOL_BROKER_URL === undefined &&
        record.env.SANDI_TOOL_BROKER_TOKEN === undefined,
      "a turn with no leased broker must not carry broker env vars",
    );
    assert(
      record.args.includes("--extension") &&
        record.args.includes(extensionPath),
      "main Pi turns should still load Sandi-owned extensions explicitly",
    );
    assert(
      record.args.includes("--append-system-prompt"),
      "main Pi turns should append the full system prompt from a payload file",
    );
    assert(
      valueAfter(record.args, "--model") === "gpt-5.5",
      "turns should use the configured Pi model by default",
    );
    assert(
      valueAfter(record.args, "--thinking") === "high",
      "turns should use the configured Pi thinking mode by default",
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

    await new PiCliClient(config).generateTurn({
      conversationId: "thread-title-test",
      instructions: "title instructions",
      input: "title stdin",
      sessionMode: "none",
      memoryContext: {
        memoryRoot: join(tempRoot, "memory"),
        memoryScopes: [],
        participants: [],
      },
      thinking: "low",
    });
    const overrideRecord = parseRecord(await readFile(recordPath, "utf8"));
    assert(
      valueAfter(overrideRecord.args, "--model") === "gpt-5.5",
      "request-level thinking overrides should keep the configured model",
    );
    assert(
      valueAfter(overrideRecord.args, "--thinking") === "low",
      "turns should support request-level thinking overrides",
    );
    assert(
      overrideRecord.args.includes("--no-session"),
      "no-session turns should disable persistent Pi sessions",
    );
    assert(
      overrideRecord.env.SANDI_SESSION_MODE === "none",
      "token usage metadata should record no-session turns",
    );

    // A hands-local (api) turn disables the native builtin tools and passes the
    // leased broker coordinates through to the child so the proxy extension can
    // reach it.
    await new PiCliClient(config).generateTurn({
      conversationId: "api-hands-local",
      instructions: "api instructions",
      input: "api stdin",
      sessionMode: "persistent",
      surfaceContext: {
        name: "api",
        skillsSurface: "api",
        runtimeImport: "./sandi/runtime.ts",
        runtimeEntry: "./src/host/runtime/index.ts",
        disableBuiltinTools: true,
      },
      localToolBroker: { url: "http://127.0.0.1:9", token: "broker-secret" },
      memoryContext: {
        memoryRoot: join(tempRoot, "memory"),
        memoryScopes: [],
        participants: [],
      },
    });
    const apiRecord = parseRecord(await readFile(recordPath, "utf8"));
    assert(
      apiRecord.args.includes("--no-builtin-tools"),
      "api turns disable pi's native builtin file and shell tools",
    );
    assert(
      !apiRecord.args.includes("--exclude-tools"),
      "api turns no longer exclude sandi_js_run: one trusted environment, the same trust other surface turns run under",
    );
    assert(
      apiRecord.env.SANDI_TOOL_BROKER_URL === "http://127.0.0.1:9",
      "api turns pass the leased broker url to the child",
    );
    assert(
      apiRecord.env.SANDI_TOOL_BROKER_TOKEN === "broker-secret",
      "api turns pass the leased broker token to the child",
    );

    // Attachment paths ride as `@<path>` argv tokens alongside the stdin-piped
    // message, per the mechanism confirmed in ProviderTurnRequest.attachmentPaths.
    const attachmentPath = join(tempRoot, "attachment-fixtures", "photo.png");
    await new PiCliClient(config).generateTurn({
      conversationId: "api-with-attachments",
      instructions: "attachment instructions",
      input: "look at this",
      sessionMode: "none",
      attachmentPaths: [attachmentPath],
      memoryContext: {
        memoryRoot: join(tempRoot, "memory"),
        memoryScopes: [],
        participants: [],
      },
    });
    const attachmentRecord = parseRecord(await readFile(recordPath, "utf8"));
    assert(
      attachmentRecord.args.includes(`@${attachmentPath}`),
      "an attachment path is passed as an @-prefixed argv token",
    );
    assert(
      attachmentRecord.stdin === "look at this",
      "the turn's message still rides on stdin alongside the @-file token",
    );

    // No attachments: no @-token at all, so a plain turn's argv is unaffected.
    await new PiCliClient(config).generateTurn({
      conversationId: "api-without-attachments",
      instructions: "no attachment instructions",
      input: "nothing attached",
      sessionMode: "none",
      memoryContext: {
        memoryRoot: join(tempRoot, "memory"),
        memoryScopes: [],
        participants: [],
      },
    });
    const noAttachmentRecord = parseRecord(await readFile(recordPath, "utf8"));
    assert(
      !noAttachmentRecord.args.some((arg) => arg.startsWith("@")),
      "a turn with no attachmentPaths carries no @-prefixed argv token",
    );

    console.log("Pi harness verification passed");
  } finally {
    delete process.env["FAKE_PI_RECORD_PATH"];
  }
});

type FakePiRecord = {
  args: string[];
  stdin: string;
  env: {
    PI_CODING_AGENT_DIR?: string;
    PI_PACKAGE_DIR?: string;
    SANDI_CONVERSATION_ID?: string;
    SANDI_SESSION_MODE?: string;
    SANDI_TOOL_BROKER_URL?: string;
    SANDI_TOOL_BROKER_TOKEN?: string;
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
  assignOptionalString(parsedEnv, "SANDI_TOOL_BROKER_URL", env);
  assignOptionalString(parsedEnv, "SANDI_TOOL_BROKER_TOKEN", env);
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
