// The unified Sandi runtime. Every surface points its `sandi_js_run` runtime
// entry here, so a turn from any surface can compose any server-side capability:
// a desktop turn can send a Discord message or comment on a GitHub thread, and a
// Discord turn can reach GitHub, all through `import { ... } from
// "./sandi/runtime.ts"`. The helpers reach their services with credentials from
// the environment (the Discord bot token, the gh CLI) and read the current
// platform target from SANDI_PLATFORM_CONTEXT when one is set, so a helper used
// outside its native surface works as long as the call names an explicit target.
//
// This module is loaded by the `sandi_js_run` child via a generated shim, which
// resolves the tsconfig path alias against the repo, so `@/` imports are fine
// here (unlike pi extensions, which the pi CLI loads without the alias).
export * as maps from "@/lib/runtime/sandi/maps";
export * as discord from "@/surfaces/discord/runtime/discord";
export * as events from "@/surfaces/discord/runtime/events";
export * as reminders from "@/surfaces/discord/runtime/reminders";
export * as todo from "@/surfaces/discord/runtime/todo";
export * as github from "@/surfaces/github/runtime/github";
