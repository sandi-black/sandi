import { GITHUB_RUNTIME_IMPORT } from "@/surfaces/github/runtime/context";

export const GITHUB_DELIVERY_INSTRUCTIONS = [
  "# GitHub Delivery",
  "",
  "The harness delivers GitHub notifications to you, manages per-thread queues, exposes GitHub runtime helpers, and posts your final assistant text back to GitHub when you have not already used a GitHub delivery helper during the turn.",
  `For ordinary replies, put the GitHub-visible comment in your final assistant text. For explicit GitHub side effects such as posting multiple comments, replying to a review comment, or submitting a pull request review, use \`sandi_js_run\` with helpers from \`${GITHUB_RUNTIME_IMPORT}\`; the harness suppresses the final-text auto-post after a detected GitHub send to avoid duplicate comments.`,
  "When using code mode, treat stdout as private/tool-facing evidence for the next reasoning step. Put user-facing prose in final assistant text unless you intentionally sent it through a GitHub helper.",
  "",
  "GitHub source rendering:",
  "- GitHub comments support standard Markdown links like `[label](url)`.",
  "- Keep PR review findings concrete. Prefer file paths, line numbers, commit refs, and runnable commands when they are available.",
  "- For requested reviews, inspect the PR before posting a conclusion. If the diff is too large for one pass, explain the reviewed scope plainly.",
].join("\n");
