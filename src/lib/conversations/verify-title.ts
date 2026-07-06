import assert from "node:assert/strict";

import {
  conversationTitleInstructions,
  DEFAULT_TITLE_MAX_LENGTH,
  normalizeGeneratedTitle,
  titleRequestInput,
} from "@/lib/conversations/title";

// The instructions builder renders the shared rules and folds in the caller's
// subject, ceiling, and placeholder.
const instructions = conversationTitleInstructions({
  subject: "title for a Sandi desktop conversation",
  maxLength: 80,
  placeholder: "New conversation",
});
assert.match(
  instructions,
  /Write a concise title for a Sandi desktop conversation\./,
);
assert.match(instructions, /Return exactly one title/);
assert.match(instructions, /no wrapping quotes/);
assert.match(instructions, /under 80 characters/);
assert.match(instructions, /return "New conversation"/);

// The normalizer strips wrapping quotes, a leading label, and a trailing
// period, and takes only the first non-empty line.
assert.equal(
  normalizeGeneratedTitle('"Deploy Checklist Help"'),
  "Deploy Checklist Help",
);
assert.equal(
  normalizeGeneratedTitle("Title: dinner plan tweaks."),
  "dinner plan tweaks",
);
assert.equal(
  normalizeGeneratedTitle("\n\nBug triage from logs\nextra text"),
  "Bug triage from logs",
);
assert.equal(normalizeGeneratedTitle(" \n\t "), undefined);

// The ceiling is honored, and defaults to DEFAULT_TITLE_MAX_LENGTH.
const longDefault = normalizeGeneratedTitle("x".repeat(200));
assert(longDefault);
assert.equal(longDefault.length, DEFAULT_TITLE_MAX_LENGTH);
assert(longDefault.endsWith("..."));

const longCustom = normalizeGeneratedTitle("y".repeat(200), 40);
assert(longCustom);
assert.equal(longCustom.length, 40);
assert(longCustom.endsWith("..."));

// A short title is returned untouched, never padded or truncated.
assert.equal(normalizeGeneratedTitle("Orbit tables", 40), "Orbit tables");

// The request input carries the task, the author (displayName defaults to the
// username), the message, and any extra surface context.
const request: unknown = JSON.parse(
  titleRequestInput({
    task: "Generate a short title for this Sandi desktop conversation.",
    authorUsername: "ada",
    message: "Help me plot the Bernoulli numbers.",
    context: { surface: "desktop" },
  }),
);
assert(isRecord(request));
assert.equal(
  request["task"],
  "Generate a short title for this Sandi desktop conversation.",
);
const author = request["author"];
assert(isRecord(author));
assert.equal(author["username"], "ada");
assert.equal(author["displayName"], "ada", "displayName defaults to username");
assert.equal(request["surface"], "desktop");
assert.equal(request["userMessage"], "Help me plot the Bernoulli numbers.");

// An explicit display name is preserved.
const named: unknown = JSON.parse(
  titleRequestInput({
    task: "t",
    authorUsername: "grace",
    authorDisplayName: "Grace Hopper",
    message: "hi",
  }),
);
assert(isRecord(named));
const namedAuthor = named["author"];
assert(isRecord(namedAuthor));
assert.equal(namedAuthor["displayName"], "Grace Hopper");

console.log("conversation title verification passed");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
