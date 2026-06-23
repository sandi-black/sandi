export const PASSIVE_REPLY_GATE_THINKING = "low";
export const PASSIVE_REPLY_GATE_TIMEOUT_MS = 30_000;

export const PASSIVE_REPLY_DECISION_RESPOND = "RESPOND";
export const PASSIVE_REPLY_DECISION_IGNORE = "IGNORE";

export const PASSIVE_REPLY_GATE_INSTRUCTIONS = [
  "You are a fast routing gate for Sandi, a household agent that passively reads every message in the Discord channels she can see.",
  "Decide whether the latest Discord message is meant for Sandi and warrants a reply from her right now.",
  `Answer ${PASSIVE_REPLY_DECISION_RESPOND} when the message addresses Sandi by name, asks a question she could answer, requests something she could help with, follows up on a conversation she is part of, or clearly invites her input.`,
  `Answer ${PASSIVE_REPLY_DECISION_IGNORE} for ordinary human-to-human chatter, side conversations, acknowledgements, reactions, or anything where Sandi speaking up would be unwelcome or irrelevant.`,
  `When it is unclear whether the message is meant for Sandi, prefer ${PASSIVE_REPLY_DECISION_IGNORE} so she stays quiet.`,
  "Direct @-mentions of Sandi and replies to her own messages are handled elsewhere and never reach you, so do not assume the message mentions her.",
  "Judge only the latest message. The recent messages are context for what is being discussed, not things to answer.",
  `Return exactly one word: ${PASSIVE_REPLY_DECISION_RESPOND} or ${PASSIVE_REPLY_DECISION_IGNORE}. No punctuation, markdown, or explanation.`,
].join("\n");

export type PassiveReplyGateContextMessage = {
  author: string;
  content: string;
};

export type PassiveReplyGateRequest = {
  sandiName: string;
  channelName: string;
  author: {
    username: string;
    displayName: string;
  };
  message: string;
  repliedTo?: PassiveReplyGateContextMessage;
  recentMessages: PassiveReplyGateContextMessage[];
};

export function passiveReplyGateRequestInput(
  request: PassiveReplyGateRequest,
): string {
  return JSON.stringify(
    {
      task: "Decide whether Sandi should reply to the latest Discord message.",
      sandiName: request.sandiName,
      channelName: request.channelName,
      latestMessage: {
        author: request.author,
        content: request.message,
        ...(request.repliedTo ? { replyingTo: request.repliedTo } : {}),
      },
      recentMessages: request.recentMessages,
    },
    null,
    2,
  );
}

export function parsePassiveReplyGateDecision(raw: string): boolean {
  const match = raw
    .toUpperCase()
    .match(
      new RegExp(
        `\\b(${PASSIVE_REPLY_DECISION_RESPOND}|${PASSIVE_REPLY_DECISION_IGNORE})\\b`,
      ),
    );
  return match?.[1] === PASSIVE_REPLY_DECISION_RESPOND;
}
