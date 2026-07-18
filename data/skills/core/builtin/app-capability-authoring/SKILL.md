---
name: app-capability-authoring
description: Use when creating, reviewing, or updating a skill that teaches Sandi how to operate a particular desktop, native, Electron, or browser application; especially when deciding which discovered controls, workflows, safety boundaries, and verification steps are durable enough to document.
---

# App Capability Authoring

Use this skill with `skill-creator` when turning successful computer use into a
reusable app-specific skill. Read `computer-use` and, for native Windows work,
`autoit-automation` before investigating the application.

An app capability skill is a durable route back to safe discovery and action.
It is not a saved UI snapshot.

## Default Stance

- Record stable app identity hints, rediscovery recipes, preferred interfaces,
  known limitations, consent boundaries, and verification rules.
- Reinspect the live app and retain a fresh HWND/PID or browser target for every
  task. Treat documented control identities as filters to verify, not authority
  to mutate.
- Prefer semantic routes: Chrome DOM for page content, native Control functions,
  scoped UI Automation (UIA), safe editor insertion, then one guarded visual
  action only when the earlier routes are unavailable.
- Create an app skill after a workflow has repeated or a verified capability
  would materially reduce risky rediscovery. Do not create one merely because an
  app was opened once.

## Authoring Workflow

1. **Define the job.** Name the app, the user-visible tasks the skill supports,
   the relevant surface (native shell, browser page, or both), and clear near
   misses that should use another skill.
2. **Identify the app safely.** Record process or executable hints and bounded
   window matching rules. Note title text that contains user data and therefore
   must not be copied into the skill.
3. **Inspect representative states.** Use read-only DOM, Control, or scoped UIA
   inspection in at least the states needed by the workflow. Keep output bounds
   low. For Electron apps, identify the native/document boundary before opting
   into document descendants.
4. **Exercise the narrow capability.** With authorization, test one harmless or
   reversible mutation through the preferred interface, wait for the real state
   change, verify it in the same target, and restore or clean up test state.
5. **Classify every finding.** Keep durable invariants and rediscovery recipes.
   Mark version-sensitive hints as such. Discard ephemeral runtime identities and
   private content.
6. **Draft from the template.** Read
   `references/app-capability-template.md` and keep only sections the app needs.
   Put app-specific detail in the app skill, not in this meta-skill.
7. **Retest from a fresh state.** Relaunch or navigate anew, rediscover the
   target, and run a non-destructive smoke test without relying on handles,
   paths, coordinates, or target ids from authoring.
8. **Validate skill behavior.** Test realistic trigger prompts and near misses,
   compare against `computer-use` and adjacent app skills, then run the closest
   repository or runtime skill verification.

## What Belongs In An App Skill

- Stable process/executable names and conservative window matching guidance.
- Which interface owns each surface: Chrome DOM, native controls, UIA document,
  editor insertion, or guarded visual fallback.
- Stable AutomationId, role/control type, accessible name, class, or DOM role
  hints when they were verified across fresh state. Include expected uniqueness
  and the fallback inspection query.
- Required preconditions, such as which view must be open or which control must
  be focused for safe editor insertion.
- The safe action sequence, explicit submit boundary, waits, and post-action
  verification.
- Known provider quirks, unsupported states, version sensitivity, and the signal
  that should trigger reinspection.
- Consent, privacy, destructive-action, account, purchase, messaging, and game
  safety boundaries relevant to the app.

## What Must Stay Ephemeral

Never preserve these in an app capability skill:

- HWNDs, PIDs, native HWNDs, UIA root-relative paths, browser page or session
  ids, DevTools target ids, or process launch ids.
- Absolute or normalized click coordinates, screenshots, current geometry, DPI,
  focus state, or visual-observation contracts.
- User content, document titles, chat text, filenames containing private data,
  account identifiers, credentials, cookies, clipboard contents, or raw tool
  dumps.
- A claim that a control is safe because it matched once. Future execution must
  revalidate target identity and uniqueness.

Store person-specific app preferences in scoped memory. Put deterministic
enforcement in code, not in a skill. Link a helper script only when it reduces a
repeated fragile procedure without weakening the guarded tool boundary.

## Provider And Drift Rules

- A desktop app may expose native window chrome while placing its content inside
  one UIA Document. Document that boundary and use bounded document inspection
  only when Chrome DOM or ordinary native controls cannot own the task.
- Prefer roles and accessible names over brittle CSS or tree positions for web
  apps. Prefer AutomationId plus control type and name for native apps when all
  are stable.
- Treat class names and title patterns as supporting evidence, not identity by
  themselves.
- If expected controls are absent, duplicated, renamed, or expose different
  actions, stop before mutation and reinspect. Do not fall through to stored
  coordinates.
- Record the tested app/version only as evidence. Write the workflow so a future
  version mismatch causes verification or reinspection rather than an automatic
  refusal or blind action.

## Review Checklist

- The app skill triggers on app-specific tasks, not generic computer use.
- It says which live inspection must happen before action.
- Every mutation retains and revalidates the current target.
- Draft insertion and submission are separate explicit actions.
- Every action has a same-target verification step and an ambiguity rule.
- Visual fallback is narrow, fresh, and subject to the restrictions in
  `computer-use` and `autoit-automation`.
- No ephemeral identity, coordinate, private content, or secret was copied from
  authoring evidence.
- A fresh-launch smoke test and near-miss trigger check passed.
