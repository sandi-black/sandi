export type TopLevelEngagementRoute = "inline" | "thread";

export function topLevelEngagementRoute(input: {
  isReplyToSandi: boolean;
  isInlineReplyChannel: boolean;
}): TopLevelEngagementRoute {
  return input.isReplyToSandi || input.isInlineReplyChannel
    ? "inline"
    : "thread";
}
