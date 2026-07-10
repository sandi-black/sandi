// A location a scheduled event, reminder, or interactive todo list targets:
// either a specific Discord thread or a standing channel. Kept structural
// (not aliased to EventTarget/ReminderTarget) so this module has no
// dependency on the events/reminders schema files and stays reachable from
// the Pi extension chain via relative imports only.
export type MatchableTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "channel"; channelId: string };

export function targetMatches(
  item: { target: MatchableTarget },
  target: MatchableTarget,
): boolean {
  if (item.target.kind === "thread" && target.kind === "thread") {
    return item.target.threadId === target.threadId;
  }
  if (item.target.kind === "channel" && target.kind === "channel") {
    return item.target.channelId === target.channelId;
  }
  return false;
}

// Same comparison as targetMatches, kept under its own name because scheduled
// events and reminders/todos read more clearly at their call sites this way.
export const eventTargetMatches = targetMatches;

export function formatTargetLabel(target: MatchableTarget | undefined): string {
  if (!target) return "current conversation";
  return target.kind === "thread" ? "this thread" : "this channel";
}
