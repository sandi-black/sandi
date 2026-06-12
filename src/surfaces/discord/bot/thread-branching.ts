const CREATE_THREAD_PREFIX =
  /^(?:(?:please\s+)?(?:can|could|would)\s+you\s+|please\s+)?(?:create|make|start|open)\s+(?:a\s+)?thread\b/i;
const BRANCH_THREAD_PREFIX =
  /^(?:(?:please\s+)?(?:can|could|would)\s+you\s+|please\s+)?(?:branch|split|move)\s+(?:(?:this|that|it|this\s+(?:discussion|conversation|topic))\s+)?(?:into|to|off\s+into)\s+(?:a\s+)?thread\b/i;
const INLINE_MESSAGE_PREFIX = /^\s*(?::|(?:about|for|on|with|saying)\b)\s*/i;

export type NaturalThreadRequest =
  | {
      kind: "create";
      starter: string;
    }
  | {
      kind: "clarify";
      reason: string;
    }
  | {
      kind: "none";
    };

export function parseNaturalThreadRequest(input: {
  content: string;
  referencedMessageContent?: string | undefined;
}): NaturalThreadRequest {
  const content = normalizeThreadText(input.content);
  if (!/\bthread\b/i.test(content)) return { kind: "none" };

  const afterCreate = stripPrefix(content, CREATE_THREAD_PREFIX);
  if (afterCreate !== undefined) {
    return threadRequestFromSuffix({
      suffix: afterCreate,
      referencedMessageContent: input.referencedMessageContent,
    });
  }

  const afterBranch = stripPrefix(content, BRANCH_THREAD_PREFIX);
  if (afterBranch !== undefined) {
    return threadRequestFromSuffix({
      suffix: afterBranch,
      referencedMessageContent: input.referencedMessageContent,
    });
  }

  return { kind: "none" };
}

function threadRequestFromSuffix(input: {
  suffix: string;
  referencedMessageContent: string | undefined;
}): NaturalThreadRequest {
  const inlineStarter = starterFromSuffix(input.suffix);
  if (inlineStarter) return { kind: "create", starter: inlineStarter };

  const referencedStarter = normalizeThreadText(
    input.referencedMessageContent ?? "",
  );
  if (referencedStarter) return { kind: "create", starter: referencedStarter };

  return {
    kind: "clarify",
    reason:
      'I can make a thread, but I need a message/topic for it. Try `/sandi thread message:"..."`, say `create a thread about ...`, or reply to the message you want branched.',
  };
}

function starterFromSuffix(suffix: string): string | undefined {
  const trimmed = normalizeThreadText(suffix);
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(INLINE_MESSAGE_PREFIX, "").trim();
  if (!withoutPrefix) return undefined;
  return withoutPrefix;
}

function stripPrefix(value: string, prefix: RegExp): string | undefined {
  const match = prefix.exec(value);
  if (!match || match.index !== 0) return undefined;
  return value.slice(match[0].length).trim();
}

function normalizeThreadText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
