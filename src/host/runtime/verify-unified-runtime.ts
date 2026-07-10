import * as runtime from "@/host/runtime/index";
import { assert } from "@/lib/verification/harness";

// Env that the runtime helpers read to find the current platform target. Cleared
// before the cross-surface cases so a developer's own .env cannot make a helper
// think it has a current Discord channel or GitHub thread.
const CONTEXT_ENV = [
  "SANDI_PLATFORM_CONTEXT",
  "SANDI_DISCORD_CONTEXT",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
];

async function verifyUnifiedRuntime(): Promise<void> {
  verifyEverySurfaceIsExposed();
  await verifyDiscordRequiresAnExplicitTargetCrossSurface();
  await verifyGithubRequiresAnExplicitTargetCrossSurface();
  console.log("unified runtime verification passed");
}

// The unified runtime is what makes "all tools everywhere" real: a turn from any
// surface imports it and reaches every surface's server-side helpers.
function verifyEverySurfaceIsExposed(): void {
  assert(
    typeof runtime.discord?.sendMessage === "function",
    "discord.sendMessage is exposed",
  );
  assert(
    typeof runtime.github?.comment === "function",
    "github.comment is exposed",
  );
  assert(typeof runtime.events === "object", "events helpers are exposed");
  assert(
    typeof runtime.reminders === "object",
    "reminders helpers are exposed",
  );
  assert(typeof runtime.todo === "object", "todo helpers are exposed");
  assert(typeof runtime.maps === "object", "maps helpers are exposed");
}

// On a turn that did not originate on Discord there is no current channel, so a
// helper must either be given an explicit target or fail with a clear message,
// never with the old "platform context is not set" that blocked cross-surface
// use entirely.
async function verifyDiscordRequiresAnExplicitTargetCrossSurface(): Promise<void> {
  await withEnv({ DISCORD_BOT_TOKEN: "dummy-token" }, async () => {
    await expectThrows(
      () => runtime.discord.sendMessage({ content: "hi" }),
      "no current Discord channel",
      "sending to the current channel off-Discord asks for an explicit channel",
    );
    await expectThrows(
      () => runtime.discord.sendMessage({ channel: "#general", content: "hi" }),
      "guild/server",
      "resolving a channel by name off-Discord asks for a guild",
    );
    expectThrowsSync(
      () => runtime.discord.currentContext(),
      "platform context is not set",
      "currentContext still fails fast without a Discord turn",
    );
  });
}

async function verifyGithubRequiresAnExplicitTargetCrossSurface(): Promise<void> {
  await withEnv({}, async () => {
    await expectThrows(
      () => runtime.github.comment({ body: "hi" }),
      "Provide owner, repo, and number",
      "commenting off-GitHub asks for an explicit owner/repo/number",
    );
    expectThrowsSync(
      () => runtime.github.currentContext(),
      "require SANDI_PLATFORM_CONTEXT",
      "currentContext still fails fast without a GitHub turn",
    );
  });
}

async function withEnv(
  overrides: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const snapshot = new Map<string, string | undefined>();
  for (const name of CONTEXT_ENV) {
    snapshot.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of snapshot) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function expectThrows(
  fn: () => Promise<unknown>,
  needle: string,
  label: string,
): Promise<void> {
  let message: string | undefined;
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMessage(message, needle, label);
}

function expectThrowsSync(
  fn: () => unknown,
  needle: string,
  label: string,
): void {
  let message: string | undefined;
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMessage(message, needle, label);
}

function assertMessage(
  message: string | undefined,
  needle: string,
  label: string,
): void {
  if (message === undefined) {
    console.error(
      `${label}: expected an error mentioning "${needle}", got none`,
    );
    process.exit(1);
  }
  if (!message.includes(needle)) {
    console.error(
      `${label}: expected an error mentioning "${needle}", got "${message}"`,
    );
    process.exit(1);
  }
}

await verifyUnifiedRuntime();
