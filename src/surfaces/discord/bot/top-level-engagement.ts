import type { TurnSignal } from "../../../lib/provider/turn-signals";

export const TOP_LEVEL_THREAD_SUGGESTION_LENGTH = 4;
export const TOP_LEVEL_RESPONSE_ROUTE_SIGNAL = "discord:response-route";

export type TopLevelEngagementRoute = "inline" | "thread";

export type ReplyChainMessage = {
  id: string;
  referencedMessageId?: string;
};

const THREAD_EMOJI =
  /(?:^|[^\p{L}\p{N}_]):thread:(?=$|[^\p{L}\p{N}_])|<a?:thread:\d+>/iu;

export function defaultTopLevelEngagementRoute(
  message: string,
): TopLevelEngagementRoute {
  return THREAD_EMOJI.test(message) ? "thread" : "inline";
}

export function resolveTopLevelEngagementRoute(input: {
  defaultRoute: TopLevelEngagementRoute;
  requestedRoute?: TopLevelEngagementRoute;
}): TopLevelEngagementRoute {
  return input.requestedRoute ?? input.defaultRoute;
}

export function requestedTopLevelEngagementRoute(
  signals: readonly TurnSignal[],
): TopLevelEngagementRoute | undefined {
  for (const signal of signals.toReversed()) {
    if (signal.kind !== TOP_LEVEL_RESPONSE_ROUTE_SIGNAL) continue;
    if (signal.value === "inline" || signal.value === "thread") {
      return signal.value;
    }
  }
  return undefined;
}

export async function countReplyChainUpTo(input: {
  start: ReplyChainMessage;
  maximumLength: number;
  fetchReferencedMessage: (messageId: string) => Promise<ReplyChainMessage>;
}): Promise<number> {
  let length = 1;
  let current = input.start;
  const seen = new Set([current.id]);
  while (length < input.maximumLength) {
    const referencedId = current.referencedMessageId;
    if (!referencedId || seen.has(referencedId)) break;
    current = await input.fetchReferencedMessage(referencedId);
    seen.add(referencedId);
    length += 1;
  }
  return length;
}

export function topLevelEngagementInstructions(input: {
  defaultRoute: TopLevelEngagementRoute;
  replyChainLength: number;
}): string {
  const defaultInstruction =
    input.defaultRoute === "thread"
      ? "The user's message contains the :thread: emoji, so the default is to create a thread for your response."
      : "The default is to reply inline to the user's top-level message.";
  const instructions = [
    "# Top-level Discord response routing",
    "",
    defaultInstruction,
    "Use `discord_route_response` only when you want to override that default. Choose `thread` to create a managed thread or `inline` to reply to the current message in this channel.",
    "The tool records the route for your automatic final response; it does not post the response itself. Omit the tool call to accept the default.",
    "Do not use `discord_create_thread` for this response choice. The host creates and registers the managed thread after your turn.",
  ];
  if (input.replyChainLength >= TOP_LEVEL_THREAD_SUGGESTION_LENGTH) {
    instructions.push(
      "",
      `This top-level reply chain is at least ${TOP_LEVEL_THREAD_SUGGESTION_LENGTH} messages long, counting user and Sandi messages. Consider creating a thread so the conversation can continue there. This is a suggestion; choose inline when it fits better.`,
    );
  }
  return instructions.join("\n");
}
