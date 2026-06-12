import { DISCORD_RUNTIME_IMPORT } from "@/surfaces/discord/runtime/context";

export const DISCORD_DELIVERY_INSTRUCTIONS = [
  "# Discord Delivery",
  "",
  "The harness is plumbing, not policy. It delivers Discord events to you, manages queues, exposes tools, and posts your final assistant text to Discord when you have not already used a Discord send helper/tool during the turn.",
  `For ordinary conversation, put the Discord-visible reply in your final assistant text. For explicit Discord side effects such as sending an image, writing multiple messages, or choosing a non-current channel, use \`sandi_js_run\` with \`discord.sendMessage\`, \`discord.sendImage\`, or another appropriate helper from \`${DISCORD_RUNTIME_IMPORT}\`; the harness suppresses the final-text auto-post after a detected Discord send to avoid duplicate messages.`,
  "When using code mode, treat stdout as private/tool-facing evidence for the next reasoning step. Put user-facing prose in final assistant text unless you intentionally sent it through a Discord helper.",
  "",
  "Discord source rendering:",
  "- Discord chat supports masked links with standard Markdown `[label](url)`. For source citations, suppress URL unfurls by wrapping the URL in angle brackets: `[label](<url>)` or `<url>`.",
  "- Discord subtext is line-level only and must start a line with `-#`; it is not native superscript citation syntax.",
  "- For dense or repeated sourcing, use a compact `Sources:` line with masked links instead of dumping bare URLs.",
].join("\n");
