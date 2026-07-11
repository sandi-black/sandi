import assert from "node:assert/strict";

import "@/surfaces/discord/runtime/verify-discord-io";

import { resolveGuildId } from "@/surfaces/discord/runtime/guild";
import {
  DeleteMessageInputSchema,
  DiscordMessageIdSchema,
  explicitChannelId,
  GetMessageInputSchema,
  parseChannelTarget,
  ReadAttachmentInputSchema,
  ReadChannelHistoryInputSchema,
  SearchChannelHistoryInputSchema,
  SendFileInputSchema,
  SendImageInputSchema,
  SendMessageInputSchema,
} from "@/surfaces/discord/runtime/targets";

const CHANNEL = "123456789012345678";
const GUILD = "111111111111111111";
const MESSAGE = "987654321098765432";

// parseChannelTarget resolves the context keywords, explicit snowflakes (a bare
// id, a <#id> mention, or a channel URL), and bare names into a precise target.
assert.deepEqual(parseChannelTarget("current"), { kind: "current" });
assert.deepEqual(parseChannelTarget("  parent "), { kind: "parent" });
assert.deepEqual(parseChannelTarget(CHANNEL), { kind: "id", id: CHANNEL });
assert.deepEqual(parseChannelTarget(`<#${CHANNEL}>`), {
  kind: "id",
  id: CHANNEL,
});
assert.deepEqual(
  parseChannelTarget(`https://discord.com/channels/1/${CHANNEL}`),
  { kind: "id", id: CHANNEL },
);
assert.deepEqual(parseChannelTarget("#general"), {
  kind: "name",
  name: "general",
});
// A name that merely contains a long digit run is a name, not an id: the id
// forms must match the whole reference, no substring extraction.
assert.deepEqual(parseChannelTarget(`team-${CHANNEL}`), {
  kind: "name",
  name: `team-${CHANNEL}`,
});
assert.throws(() => parseChannelTarget("   "), /must not be empty/);

// explicitChannelId accepts an id, mention, or URL but rejects an empty or
// unresolvable reference (a turn outside Discord has no channel list for a name).
assert.equal(explicitChannelId(CHANNEL), CHANNEL);
assert.equal(explicitChannelId(`<#${CHANNEL}>`), CHANNEL);
assert.throws(() => explicitChannelId("  "), /must not be empty/);
assert.throws(() => explicitChannelId("general"), /channel/i);

// Message ids must be snowflakes; a non-numeric id is rejected at the boundary
// instead of producing an opaque Discord 404.
assert.equal(DiscordMessageIdSchema.parse(MESSAGE), MESSAGE);
assert.throws(() => DiscordMessageIdSchema.parse("not-a-snowflake"));

// The getMessage/deleteMessage input schemas accept an empty input (resolve from
// context), a numeric messageId, and reject a malformed one.
assert.deepEqual(GetMessageInputSchema.parse({}), {});
assert.deepEqual(GetMessageInputSchema.parse({ messageId: MESSAGE }), {
  messageId: MESSAGE,
});
assert.throws(() => GetMessageInputSchema.parse({ messageId: "abc" }));
assert.deepEqual(
  DeleteMessageInputSchema.parse({ messageId: MESSAGE, reason: "spam" }),
  { messageId: MESSAGE, reason: "spam" },
);
assert.throws(() => DeleteMessageInputSchema.parse({ channel: "" }));

// History and search helpers parse their channel/message cursor boundaries and
// reject malformed numeric knobs before route/query construction.
assert.deepEqual(
  ReadChannelHistoryInputSchema.parse({
    channel: `#general`,
    limit: 25,
    beforeMessageId: MESSAGE,
  }),
  {
    channel: `#general`,
    limit: 25,
    beforeMessageId: MESSAGE,
  },
);
assert.throws(() => ReadChannelHistoryInputSchema.parse({ limit: 1.5 }));
assert.throws(() =>
  ReadChannelHistoryInputSchema.parse({ beforeMessageId: "abc" }),
);
assert.throws(() =>
  ReadChannelHistoryInputSchema.parse({
    beforeMessageId: MESSAGE,
    afterMessageId: CHANNEL,
  }),
);
assert.deepEqual(
  SearchChannelHistoryInputSchema.parse({
    query: " needle ",
    maxMessages: 100,
    caseSensitive: true,
  }),
  { query: "needle", maxMessages: 100, caseSensitive: true },
);
assert.throws(() =>
  SearchChannelHistoryInputSchema.parse({ query: "needle", maxMessages: -1 }),
);
assert.throws(() =>
  SearchChannelHistoryInputSchema.parse({
    query: "needle",
    caseSensitive: "yes",
  }),
);
assert.throws(() => SearchChannelHistoryInputSchema.parse({ query: "   " }));

// Send helpers parse content, reply targets, file/image paths, and optional
// upload metadata at the runtime-helper boundary.
assert.deepEqual(
  SendMessageInputSchema.parse({
    content: " hello ",
    replyToMessageId: MESSAGE,
    allowMentions: false,
  }),
  { content: "hello", replyToMessageId: MESSAGE, allowMentions: false },
);
assert.throws(() =>
  SendMessageInputSchema.parse({ content: "hello", replyToMessageId: "abc" }),
);
assert.throws(() => SendMessageInputSchema.parse({ content: "   " }));
assert.deepEqual(
  SendFileInputSchema.parse({
    content: "file",
    path: " /tmp/example.txt ",
    filename: " example.txt ",
    mimeType: " text/plain ",
  }),
  {
    content: "file",
    path: "/tmp/example.txt",
    filename: "example.txt",
    mimeType: "text/plain",
  },
);
assert.throws(() => SendFileInputSchema.parse({ content: "file", path: "" }));
assert.throws(() =>
  SendFileInputSchema.parse({
    content: "file",
    path: "/tmp/example.txt",
    mimeType: 'text/plain"\r\nX-Bad: yes',
  }),
);
assert.deepEqual(
  SendImageInputSchema.parse({ content: "image", path: " out.png " }),
  {
    content: "image",
    path: "out.png",
  },
);
assert.throws(() =>
  SendImageInputSchema.parse({
    content: "image",
    path: "out.png",
    allowMentions: "no",
  }),
);

// Attachment helpers share the message target schema and parse the optional
// attachment snowflake before selecting/downloading the attachment.
assert.deepEqual(
  ReadAttachmentInputSchema.parse({
    messageId: MESSAGE,
    attachmentId: CHANNEL,
  }),
  { messageId: MESSAGE, attachmentId: CHANNEL },
);
assert.throws(() =>
  ReadAttachmentInputSchema.parse({ attachmentId: "not-id" }),
);

// resolveGuildId parses both the per-turn context guild and (in its absence) the
// configured fallback through the snowflake schema, so a malformed guild id never
// reaches Discord route construction.
const priorGuildEnv = process.env["DISCORD_GUILD_ID"];
try {
  delete process.env["DISCORD_GUILD_ID"];
  assert.equal(resolveGuildId(GUILD), GUILD);
  assert.throws(() => resolveGuildId("not-a-guild"));
  assert.throws(() => resolveGuildId(undefined), /requires a guild/);
  process.env["DISCORD_GUILD_ID"] = GUILD;
  assert.equal(resolveGuildId(undefined), GUILD);
  process.env["DISCORD_GUILD_ID"] = "bogus";
  assert.throws(() => resolveGuildId(undefined), /snowflake/);
} finally {
  if (priorGuildEnv === undefined) delete process.env["DISCORD_GUILD_ID"];
  else process.env["DISCORD_GUILD_ID"] = priorGuildEnv;
}

console.log("discord runtime targets verification passed");
