import {
  conversationTitleInstructions,
  normalizeGeneratedTitle,
  TITLE_TURN_THINKING,
  TITLE_TURN_TIMEOUT_MS,
  titleRequestInput,
} from "@/lib/conversations/title";

// Discord-specific framing over the shared conversation-title core: the thread
// keeps its placeholder name until the model turns the starter message into a
// real one.
export const MENTION_THREAD_PLACEHOLDER_TITLE = "new thread";
export const MENTION_THREAD_TITLE_THINKING = TITLE_TURN_THINKING;
export const MENTION_THREAD_TITLE_TIMEOUT_MS = TITLE_TURN_TIMEOUT_MS;
// A Discord thread name cannot exceed 100 characters, so titles are capped
// there before setName is ever called.
export const DISCORD_THREAD_TITLE_MAX_LENGTH = 100;

export const THREAD_TITLE_INSTRUCTIONS = conversationTitleInstructions({
  subject: "Discord thread title for a Sandi conversation",
  maxLength: DISCORD_THREAD_TITLE_MAX_LENGTH,
  placeholder: MENTION_THREAD_PLACEHOLDER_TITLE,
});

export function threadTitleRequestInput(input: {
  authorUsername: string;
  authorDisplayName?: string | undefined;
  channelName: string;
  message: string;
}): string {
  return titleRequestInput({
    task: "Generate a Discord thread title for this Sandi conversation.",
    authorUsername: input.authorUsername,
    authorDisplayName: input.authorDisplayName,
    message: input.message,
    context: { channelName: input.channelName },
  });
}

export function normalizeGeneratedThreadTitle(raw: string): string | undefined {
  return normalizeGeneratedTitle(raw, DISCORD_THREAD_TITLE_MAX_LENGTH);
}
