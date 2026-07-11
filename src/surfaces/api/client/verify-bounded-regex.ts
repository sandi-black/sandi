import { assert, assertEqual } from "@/lib/verification/harness";
import { compileBoundedRegex } from "@/surfaces/api/client/bounded-regex";
import { MAX_LOCAL_GREP_PATTERN_CHARS } from "@/surfaces/api/devices/search-limits";

export function verifyBoundedRegex(): void {
  assert(compileBoundedRegex("Grace|Ada").test("Ada"), "alternation matches");
  assert(
    compileBoundedRegex("grace", true).test("Grace"),
    "case-insensitive matching works",
  );

  // This input causes catastrophic backtracking in a traditional JavaScript
  // regex engine. RE2 evaluates it in linear time.
  const adversarial = `${"a".repeat(250_000)}!`;
  assert(
    !compileBoundedRegex("(a+)+$").test(adversarial),
    "nested repetition rejects a non-match",
  );

  assertThrows("(Ada)\\1", "backreferences");
  assertThrows("(?<=Ada)Lovelace", "lookbehind");
  assertThrows("Ada(?=Lovelace)", "lookahead");
  assertThrows("(", "invalid RE2 regular expression");
  assertThrows(
    "a".repeat(MAX_LOCAL_GREP_PATTERN_CHARS + 1),
    `${MAX_LOCAL_GREP_PATTERN_CHARS} character limit`,
  );
  assertEqual(
    compileBoundedRegex("\\\\1").test("\\1"),
    true,
    "an escaped slash followed by a digit is not mistaken for a backreference",
  );
  assert(
    compileBoundedRegex("\\(\\?=").test("(?="),
    "escaped lookaround punctuation remains a supported literal search",
  );
  console.log("ok local_grep patterns use a bounded RE2 dialect");
}

function assertThrows(pattern: string, expected: string): void {
  let message = "";
  try {
    compileBoundedRegex(pattern);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes(expected),
    `expected ${JSON.stringify(pattern)} to fail with ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`,
  );
}
