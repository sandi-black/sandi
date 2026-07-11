import { RE2 } from "re2-wasm";

import { errorMessage } from "@/lib/errors";
import { MAX_LOCAL_GREP_PATTERN_CHARS } from "@/surfaces/api/devices/search-limits";

export type BoundedRegex = {
  test(input: string): boolean;
};

/**
 * Compiles untrusted desktop-search patterns with RE2's linear-time engine.
 * Unsupported JavaScript constructs fail before the caller starts filesystem
 * traversal, keeping both validation and matching bounded.
 */
export function compileBoundedRegex(
  pattern: string,
  ignoreCase = false,
): BoundedRegex {
  if (pattern.length > MAX_LOCAL_GREP_PATTERN_CHARS) {
    throw new Error(
      `regular expression exceeds the ${MAX_LOCAL_GREP_PATTERN_CHARS} character limit`,
    );
  }
  const unsupported = unsupportedConstruct(pattern);
  if (unsupported) {
    throw new Error(
      `${unsupported} is not supported by the RE2 search dialect`,
    );
  }
  try {
    return new RE2(pattern, ignoreCase ? "iu" : "u");
  } catch (error) {
    throw new Error(`invalid RE2 regular expression: ${errorMessage(error)}`);
  }
}

function unsupportedConstruct(pattern: string): string | undefined {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (current === "\\") {
      const next = pattern[index + 1] ?? "";
      if (!inCharacterClass && next >= "1" && next <= "9") {
        return "backreferences";
      }
      index += 1;
      continue;
    }
    if (current === "[") {
      inCharacterClass = true;
      continue;
    }
    if (current === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass || current !== "(" || pattern[index + 1] !== "?") {
      continue;
    }
    const marker = pattern[index + 2];
    if (marker === "=" || marker === "!") return "lookahead";
    if (
      marker === "<" &&
      (pattern[index + 3] === "=" || pattern[index + 3] === "!")
    ) {
      return "lookbehind";
    }
  }
  return undefined;
}
