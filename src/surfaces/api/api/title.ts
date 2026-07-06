import {
  conversationTitleInstructions,
  titleRequestInput,
} from "@/lib/conversations/title";

// Desktop-specific framing over the shared conversation-title core. The desktop
// app keeps a fresh conversation under its "New conversation" placeholder until
// the server turns the opening message into a real title, so the placeholder
// here matches the one the app stores; a model that echoes it back names
// nothing, and the app leaves the conversation untitled.
export const DESKTOP_TITLE_PLACEHOLDER = "New conversation";
// Titles sit in a narrow sidebar, so they are kept shorter than a Discord
// thread name.
export const DESKTOP_TITLE_MAX_LENGTH = 80;

export const DESKTOP_TITLE_INSTRUCTIONS = conversationTitleInstructions({
  subject: "title for a Sandi desktop conversation",
  maxLength: DESKTOP_TITLE_MAX_LENGTH,
  placeholder: DESKTOP_TITLE_PLACEHOLDER,
});

export function desktopTitleRequestInput(input: {
  authorUsername: string;
  authorDisplayName?: string | undefined;
  message: string;
}): string {
  return titleRequestInput({
    task: "Generate a short title for this Sandi desktop conversation.",
    authorUsername: input.authorUsername,
    authorDisplayName: input.authorDisplayName,
    message: input.message,
    context: { surface: "desktop" },
  });
}
