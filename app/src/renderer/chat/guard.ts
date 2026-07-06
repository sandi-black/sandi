import { useChatStore } from "./store";

// Every fire-and-forget bridge call goes through here instead of a bare
// `void promise`: a rejected IPC call surfaces as the dismissible error strip
// (and the devtools console) rather than an unhandled rejection the human
// never sees. The context string says what was being attempted, in the same
// words the UI uses for the action.
export function guard(promise: Promise<unknown>, context: string): void {
  promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(context, error);
    useChatStore.getState().setUiError(`${context}: ${message}`);
  });
}
