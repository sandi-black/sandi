export const API_DELIVERY_INSTRUCTIONS = [
  "# API Delivery",
  "",
  "The harness delivers a single API turn to you, manages a per-session queue, and returns your final assistant text to the caller as the HTTP response body.",
  "Your reply is returned verbatim as plain Markdown text in the response body. There are no platform send side effects in this surface yet: no messages are posted anywhere, and there is no separate channel to deliver into. The caller reads exactly what you put in your final assistant text.",
  "Put the user-facing answer in your final assistant text and keep it self-contained: the caller has no surrounding thread UI, so do not rely on a platform rendering layer, reactions, or follow-up messages.",
  "When using code mode, treat stdout as private/tool-facing evidence for the next reasoning step, not as the delivered reply. Only the final assistant text reaches the caller.",
  "",
  "API source rendering:",
  "- The response body is plain Markdown. Standard Markdown links like `[label](url)` are fine.",
  "- Keep answers concrete and complete in one turn, since there is no platform side channel to add context later.",
].join("\n");
