# Code mode

Code mode is Sandi's composable tool layer. Instead of making many tiny tool calls
when a task needs local glue logic, Sandi can run one small JavaScript or
TypeScript program with `sandi_js_run` and import household/runtime helpers from
the runtime import path shown in the compiled context. Discord turns use
`./sandi/runtime.ts`.

Use code mode for composition: gathering data, branching, filtering, retrying,
formatting, and combining Sandi capabilities. Do not use code mode to hide risky
side effects; permission and consent rules still apply.

Use native Pi/Codex tools for web research and repository file operations when
they are available in the active tool list. The old Exa-backed `web` runtime
export was removed; `./sandi/runtime.ts` now focuses on Sandi-owned runtime
helpers such as Discord, events, reminders, maps, and todo state.

## Desktop MCP composition

Desktop-backed turns expose the same MCP operations as the fixed Pi tools
through `desktopMcp`. Use this when discovery and several dependent calls belong
in one code-mode run:

```ts
import { desktopMcp } from "./sandi/runtime.ts";

const matches = await desktopMcp.search({ query: "active window" });
console.log(JSON.stringify(matches.structuredContent, null, 2));

// Use an exact pair returned by search.
const serverId = "configured-server";
const toolName = "exact-tool-name";
const description = await desktopMcp.describe({ serverId, toolName });
const result = await desktopMcp.call({
  serverId,
  toolName,
  arguments: {},
});
console.log(JSON.stringify({ description, result }, null, 2));
```

The runtime uses the current turn's broker ticket, so it is unavailable when no
desktop was leased. Pass `desktop` to any operation when an identity has several
connected machines. Persistent changes are also available through
`desktopMcp.configure(...)` and are applied by the desktop host.

## Output conventions

There are three separate output channels:

1. **stdout/stderr from the script** are tool-facing evidence. Print concise JSON
   or text that helps Sandi make the next reasoning step. Do not treat stdout as
   Discord-visible user copy. The tool wraps process output in an untrusted-data
   delimiter so command output, web content, or other external text is not
   mistaken for instructions.
2. **Final assistant text** is the ordinary Discord reply. If no explicit Discord
   send helper/tool was used during the turn, the bot wrapper posts final text to
   the current Discord conversation.
3. **Discord helpers/tools** are explicit side effects. Use them for images,
   multiple messages, messages to a non-current channel, replies that need a
   specific Discord message reference, or other deliberate delivery behavior.
   Successful Discord send helpers mark the turn so the wrapper suppresses the
   automatic final-text post and avoids duplicates.

In short: use stdout for evidence, final text for normal speech, and Discord
helpers for deliberate Discord side effects.

## Top-level await

`sandi_js_run` writes scripts as ES modules, so top-level await is supported.
Prefer scratchpad-style scripts over wrapping everything in an `async main()`
function. The run directory includes symlinks to the repo's `src/` and
`node_modules/`, so scripts can import Sandi runtime helpers and installed npm
packages.

```ts
import { discord } from "./sandi/runtime.ts";

const context = discord.currentContext();
const history = await discord.readChannelHistory({ limit: 10 });

console.log(
  JSON.stringify(
    {
      currentChannel: context.threadId ?? context.channelId,
      messagesRead: history.length,
    },
    null,
    2,
  ),
);
```

## Cookbook

### Read recent Discord history and use final text for the reply

```ts
import { discord } from "./sandi/runtime.ts";

const messages = await discord.readChannelHistory({ limit: 20 });
const nonBotMessages = messages.filter((message) => !message.author.bot);

console.log(
  nonBotMessages.map((message) => `${message.author.username}: ${message.content}`).join("\n"),
);
```

After inspecting stdout, put the user-facing answer in final assistant text. Do
not call `discord.sendMessage` for a normal single reply in the current thread.

### Search older Discord history

```ts
import { discord } from "./sandi/runtime.ts";

const result = await discord.searchChannelHistory({
  query: "pi-chat",
  limit: 5,
  maxMessages: 500,
});

console.log(
  JSON.stringify(
    {
      searchedMessages: result.searchedMessages,
      reachedEnd: result.reachedEnd,
      matches: result.matches.map((match) => ({
        messageId: match.message.id,
        author: match.message.author.username,
        timestamp: match.message.timestamp,
        matchedField: match.matchedField,
        snippet: match.snippet,
      })),
    },
    null,
    2,
  ),
);
```

Use this when older Discord context may matter but recent-message history is too
small. The helper searches message content and attachment filenames, newest to
oldest, and returns bounded match metadata for the next reasoning step.

### Send an explicit Discord side effect

```ts
import { discord } from "./sandi/runtime.ts";

await discord.sendMessage({
  content:
    "This was intentionally sent from code mode. Final assistant text will not be auto-posted for this turn.",
});

console.log("sent explicit Discord message");
```

Use this shape for multiple messages, non-current channels, or special delivery
behavior. Keep any final assistant text minimal or API-facing, because Discord
has already received the visible message.

### Send a generated file

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { discord } from "./sandi/runtime.ts";

const outPath = join(process.env["SANDI_JS_RUN_DIR"] ?? ".", "summary.txt");
await writeFile(outPath, "Useful generated artifact\n", "utf8");

await discord.sendFile({
  path: outPath,
  content: "I made the requested artifact.",
});
```

`discord.sendFile` can send files created in the current code-mode run, files
under Sandi's generated/downloaded attachment areas, or checked-in assets. It
records a Discord side effect, so ordinary final assistant text is not auto-posted
for that turn.

### Generate or prepare an artifact, then report evidence

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const outPath = join(process.env["SANDI_JS_RUN_DIR"] ?? ".", "summary.txt");
await writeFile(outPath, "Useful generated artifact\n", "utf8");

console.log(JSON.stringify({ wrote: outPath }, null, 2));
```

Use stdout to preserve the artifact path or command evidence, then decide whether
final text or an explicit Discord helper should tell the household about it.

### Compose a helper function locally

```ts
import { discord } from "./sandi/runtime.ts";

type DiscordMessage = Awaited<ReturnType<typeof discord.readChannelHistory>>[number];

function summarizeMessages(messages: readonly DiscordMessage[]): string[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `${message.author.username}: ${message.content.trim()}`);
}

const messages = await discord.readChannelHistory({ limit: 15 });
console.log(summarizeMessages(messages).join("\n"));
```

Prefer small local helpers inside one script over repeated tool-call ping-pong
when the task is naturally compositional.
