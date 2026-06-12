---
name: discord-markdown
description: Use when composing Discord-native text with Markdown-specific formatting: headings, lists, quotes, code blocks, spoilers, subtext, masked links, source links, or readable message layout.
---

# Discord Markdown

Use this skill when the shape of a Discord-visible message matters: source
citations, compact status updates, readable instructions, playful emphasis,
spoilers, code snippets, lists, or any reply that should intentionally use
Discord's Markdown dialect rather than generic plain text.

Reference: Discord's Markdown Text 101 formatting guide.

## Default Style

- Use formatting to make the message easier to read, not to decorate every
  sentence.
- Prefer short paragraphs and bullets in busy threads.
- Use emphasis sparingly: `**bold**` for labels or important words, `_italics_`
  for light inflection, and `~~strikethrough~~` for small jokes or corrections.
- Keep serious or emotionally delicate messages calmer; do not turn formatting
  into glitter unless glitter is welcome.

## Common Formatting

- Headings require a space after the marker: `# Heading`, `## Heading`, or
  `### Heading`.
- Lists work with `- item` or `1. item`. Keep nesting shallow for mobile
  readability.
- Block quotes use `> quote` for one line or `>>> quote` for a multi-line quote.
- Inline code uses backticks: `` `example` ``.
- Code blocks use triple backticks. Include a language when useful:

  ````text
  ```ts
  const charm = "tiny";
  ```
  ````

- Spoilers use double pipes: `||spoiler text||`.
- Masked links use `[label](url)`.

## Discord-Specific Foibles

- Suppress source-link unfurls by wrapping URLs in angle brackets:
  `[label](<https://example.com>)` or `<https://example.com>`.
- Subtext is line-level only and must start the line with `-# `, for example:
  `-# small aside`. Do not use it as superscript citation syntax.
- Spacing matters for headings and subtext. `#Heading` and `-#aside` will not
  render like `# Heading` and `-# aside`.
- Code blocks are best for commands, logs, stack traces, JSON, and examples
  where Discord Markdown should not interpret the content.
- If Markdown characters are part of the literal text, escape them with a
  backslash or put the text in inline code/a code block.
- Discord is not full GitHub-flavored Markdown. Avoid relying on tables,
  footnotes, or HTML rendering.

## Source Citation Pattern

When web research shaped the answer, prefer concise citations that do not unfurl:

- Inline claim: `Discord supports spoilers with ||text|| ([Discord docs](<https://support.discord.com/hc/en-us/articles/210298617>)).`
- Compact source line: `Sources: [Discord Markdown Text 101](<https://support.discord.com/hc/en-us/articles/210298617>)`

Do not invent citations, and do not dump bare URLs when a masked link would be
clearer.

## Readability Checks

Before sending a heavily formatted message, quickly check:

1. Would this still read cleanly on mobile?
2. Are code blocks closed?
3. Are links masked and, for sources, unfurl-suppressed?
4. Is subtext on its own line?
5. Did formatting improve clarity or just make the message louder?
