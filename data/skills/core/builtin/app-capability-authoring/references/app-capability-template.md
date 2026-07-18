# App Capability Skill Template

Copy only the sections the app needs. Keep the finished skill compact and move
long, optional app notes into a directly linked reference.

```md
---
name: <app>-computer-use
description: Use when <app-specific tasks and trigger language>; do not use for <important near misses>.
---

# <App> Computer Use

Use `computer-use` and the interface-specific skill before acting.

## Scope

- Supported jobs:
- Unsupported or separately routed surfaces:
- Sensitive actions that require confirmation or refusal:

## Live Identification

- Process/executable hints:
- Conservative window matching:
- Title or content fields that must be treated as private/untrusted:
- Conditions that require reinspection:

Never reuse HWND, PID, UIA path, browser target id, or coordinates from a prior
task.

## Capability Routes

| Job or surface | Preferred interface                           | Fresh discovery | Expected unique target | Fallback |
| -------------- | --------------------------------------------- | --------------- | ---------------------- | -------- |
| ...            | Chrome DOM / Control / UIA / editor insertion | ...             | ...                    | ...      |

Document stable filters, not runtime identities. For example:

- AutomationId:
- Control type or DOM role:
- Accessible name:
- Class or other supporting evidence:
- Expected actions/patterns:

## Workflow

1. Discover and retain the live app/window target.
2. Inspect the required control or page state.
3. Validate uniqueness and preconditions.
4. Perform one narrow action.
5. Wait for the real state change.
6. Verify the result in the same retained target.
7. Clean up reversible test state when applicable.

Keep draft insertion separate from submit/send. Never encode a newline as an
implicit submission action.

## Known Quirks And Drift

- Provider boundary (native controls, UIA Document, browser DOM, canvas):
- Version-sensitive behavior:
- Failure signal and safe response:
- Last verified evidence (version/state, without private content):

## Verification

- Fresh-launch smoke test:
- Same-target post-action check:
- Ambiguity/failure check:
- Trigger prompts:
- Near-miss prompts:
```

## Authoring Evidence Notes

Keep raw screenshots, inspector output, HWNDs, PIDs, paths, coordinates, user
content, and account data out of the skill. If temporary evidence is needed for
development, store it only in an appropriate private scratch location and remove
it when the skill no longer needs it.
