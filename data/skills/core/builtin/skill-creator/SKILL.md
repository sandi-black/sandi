---
name: skill-creator
description: Use when creating, editing, reviewing, testing, publishing, or retiring Sandi skills; improving skill descriptions and trigger behavior; organizing bundled skill resources; or deciding whether guidance belongs in memory, a skill, docs, config, or code.
---

# Skill Creator

Use this skill when someone asks Sandi to create a new skill or improve an
existing one. A good Sandi skill turns repeated judgment into reusable operating
guidance without bloating every future turn.

Skills are for durable workflow knowledge: when to use tools, how to make a
decision, what local boundaries matter, which resources to inspect, and how to
verify the result. Keep them practical, compact, and specific enough that future
Sandi can act with less rediscovery.

## Sandi Skill Shape

Sandi skills live under the configured skills root:

```text
data/skills/
  core/
    builtin/<skill-name>/SKILL.md
    custom/<skill-name>/SKILL.md
  surfaces/<surface>/
    builtin/<skill-name>/SKILL.md
    custom/<skill-name>/SKILL.md
```

Use core skills for global behavior that applies across surfaces. Use surface
skills for behavior tied to one surface, such as chat delivery, channel history,
attachments, buttons, or household room conventions. Custom skills override
builtins with the same name.

For live self-extension, custom skills are the default. They are runtime state,
and Sandi can create, replace, or delete them without changing the repo. Builtin
skills are starter/product defaults that should be edited only when changing
what ships with the harness.

Each skill folder must contain `SKILL.md` with YAML frontmatter:

```md
---
name: food-finder
description: Use when someone asks what to eat, needs restaurant ideas, mentions cravings, menus, restaurants, delivery, or "nothing sounds good."
---
```

Only `name` and `description` are required by Sandi's loader. Keep the
frontmatter name identical to the folder name.

## Where Guidance Belongs

Choose the smallest durable home that will help future Sandi:

- Use a skill for reusable operating procedure, tool workflow, decision rules,
  recurring household patterns, or domain-specific execution guidance.
- Use memory for durable facts about people, preferences, projects, paths,
  household state, or prior decisions.
- Use docs for human-facing project explanation, architecture notes, or
  references that are not meant to steer every execution.
- Use code or config when behavior must be deterministic, enforced, testable, or
  shared by every runtime regardless of model behavior.
- Use `data/scripts/` or `data/projects/` for executable helpers, prototypes, or
  tool glue that Sandi can maintain as runtime state. A skill can describe when
  to use those helpers.

Do not hide hard product behavior in a skill when code should enforce it. Do not
store private facts in a skill when scoped memory is the safer place.

## Creation Workflow

Start from the user's intent and the current context. If the conversation already
contains the workflow to capture, extract the steps, corrections, tools, examples,
and success criteria before asking questions.

1. Define the job.
2. Choose scope and storage.
3. Draft or edit `SKILL.md`.
4. Add only useful bundled resources.
5. Validate trigger behavior and expected use.
6. Run the closest project verification.
7. Explain what changed and any breakage.

Ask questions only when the answer changes the skill's durable behavior. Prefer
one focused question over an interview when the task is already clear.

## Defining The Job

Capture enough detail to make the skill useful beyond the current example:

- What should future Sandi be able to do?
- What user phrases, contexts, or tool needs should trigger the skill?
- What should the skill help Sandi decide before acting?
- Which tools, paths, APIs, memories, or surface helpers matter?
- What output or user-visible behavior counts as success?
- What should the skill explicitly avoid?

For existing skills, preserve the skill name unless the user asks for a rename.
If a rename is the clean solution, update references and call out the breaking
change plainly.

## Scope And Storage

Use these defaults:

- `core/custom`: household or personal skill created by Sandi for general use.
- `surfaces/<surface>/custom`: surface-only household behavior, message
  delivery, channel conventions, attachment handling, buttons, reminders, or room
  context.
- `core/builtin` or `surfaces/<surface>/builtin`: checked-in product skills that
  ship with the Sandi repo.

Default to `custom` for requests to teach Sandi, personalize Sandi, preserve a
new habit, or change how the running deployment should behave. Edit checked-in
`builtin` skills only when the user is changing the shareable starter behavior
for every future checkout. When editing Sandi's checked-in builtin skills, follow
the repo-development branch of the self-development workflow: work in a
development checkout, inspect adjacent skills, run verification, and publish
through the repo workflow when requested.

When writing a runtime custom skill through Sandi tools, use `skill_write`.
Prefer `scope: "core"` only when the behavior should apply outside the current
surface. Otherwise let surface context choose the default.

## Writing Style

Write like Sandi: warm, decisive, and operational. The skill should feel like a
clear note from someone who knows the household and the runtime.

- Use direct instructions, not imported platform lore.
- Name Sandi, the relevant person or group, Pi, local paths, or the current surface only when
  relevant.
- Keep prose compact. A skill is loaded into future context, so every paragraph
  should earn its keep.
- Prefer concrete defaults over broad advice.
- Explain the reason for non-obvious boundaries.
- Keep examples realistic and local to Sandi when examples help.
- Avoid jokes or casual asides that future Sandi has to carry forever.
- Use ASCII punctuation and plain quotes.

Good Sandi skills usually have short sections, a practical default stance, and
plain tool guidance. They do not need long theory unless the theory changes
execution.

## Frontmatter Description

The description is the main trigger surface. Make it specific enough for search
and ranking, but not stuffed with every synonym.

Include:

- the action or decision the skill supports;
- important trigger phrases or contexts;
- surface constraints if the skill is surface-specific;
- near-miss language when another skill might otherwise win.

Avoid:

- vague descriptions such as "Helps with files";
- body-only "when to use" sections that repeat what should be in frontmatter;
- obsolete tool names or provider-specific language;
- promises the skill cannot actually fulfill.

Example:

```md
description: Use when someone asks Sandi to remind a human about something, especially when the reminder should have Done, Snooze, and Delete controls, repeated follow-ups until handled, or a shared-room prompt in the current chat surface.
```

## Body Structure

Use the simplest structure that future Sandi can follow quickly:

```md
# Skill Name

Use this skill when...

## Default Stance

...

## Workflow

1. ...

## Tool Notes

- ...

## Verification

- ...
```

Common useful sections:

- `Default Stance`: the operating posture.
- `Workflow`: the concrete sequence of actions.
- `Decision Rules`: how to choose between similar tools, scopes, or outputs.
- `Storage`, `Memory`, or `Disk Layout`: where durable artifacts belong.
- `Safety` or `Consent`: when to ask first.
- `Verification`: what to run or inspect before claiming done.

Skip sections that do not add signal.

## Bundled Resources

Keep `SKILL.md` as the navigation layer. Add resources only when they reduce
future work:

- `scripts/`: deterministic helpers for repeated fragile operations, validation,
  conversion, packaging, or analysis.
- `references/`: longer documentation, schemas, API notes, examples, or decision
  tables that are useful only for some tasks.
- `assets/`: templates, images, boilerplate, fonts, prompts, or other files used
  as output material.

Reference resource files from `SKILL.md` with clear read conditions:

```md
For API limits and cache behavior, read `references/provider-api.md` before
building automation.
```

Avoid resource folders full of placeholders. Delete unused examples before
shipping the skill.

## Progressive Disclosure

Future context is shared. Keep the always-loaded parts small:

1. Frontmatter: name and description.
2. `SKILL.md`: essential workflow and routing.
3. Resources: loaded or executed only when the task needs them.

If `SKILL.md` starts feeling like a manual, split variant-specific detail into
directly linked reference files. Keep references one hop away from `SKILL.md` so
future Sandi can discover them without chasing a maze.

For long reference files, include a table of contents near the top.

## Evaluation And Testing

Use verification proportional to risk.

For a simple wording cleanup:

- Read the full edited skill.
- Search for stale terms, wrong tool names, and duplicated guidance.
- Confirm the frontmatter name and folder name match.

For behavior-shaping changes:

- Create 3-6 realistic prompts that should trigger the skill.
- Create 3-6 near-miss prompts that should not trigger it.
- Compare the skill against nearby skills that could compete.
- Run `skill_search` or the local skill hinting tests when available.
- Revise the description if the wrong skill would be selected.

For skills with scripts or generated artifacts:

- Run the scripts with representative inputs.
- Keep example fixtures small and non-private.
- Add or update project tests when the repo has a test harness for the behavior.

For Sandi repo changes, run the closest project verification, usually:

```sh
npm run check
```

If the full gate cannot run, run the most relevant narrower commands and say
what remains unchecked.

For runtime custom skill changes, verification is usually readback plus behavior
sanity:

- `skill_read` the final effective skill.
- Check a few likely trigger phrases and near misses.
- Exercise referenced scripts or helpers if the skill depends on them.
- Confirm the behavior is available in the intended core or surface scope.

## Review Checklist

Before calling a skill finished, check:

- The frontmatter has `name` and `description`.
- The frontmatter name matches the folder name.
- The description says when to use the skill, not only what it is.
- The skill is stored in the right core or surface scope.
- The body is Sandi-specific where it needs to be, and surface-neutral when it
  lives under `core`.
- Tool names, paths, and runtime imports match current Sandi docs or code.
- Private household facts are not embedded unless they are intentional reusable
  guidance.
- Examples are realistic and do not mention unrelated platforms or vendors.
- Bundled resources are referenced, useful, and tested if executable.
- The skill does not ask future Sandi to do impossible work with unavailable
  tools.

## Editing Existing Skills

Read the existing skill fully before editing. Also inspect adjacent skills in the
same scope so the tone, structure, and boundaries stay consistent.

When improving a skill:

- Keep the name stable unless the rename is the point of the change.
- Remove obsolete or imported instructions rather than preserving compatibility
  with tools Sandi does not use.
- Prefer a complete coherent rewrite over a pile of exception clauses when the
  old structure is wrong.
- Preserve useful local knowledge, examples, and safety boundaries.
- Update or delete bundled resources that no longer match the body.
- Search the repo for references to old names, paths, or concepts after a rename
  or major rewrite.

If the change affects how future Sandi behaves, mention the behavior change
plainly in the final response or PR description.

## Custom Skill Writes

When creating or updating a runtime custom skill through Sandi:

1. Use `skill_list` or `skill_search` to check for existing skills first.
2. Read the current effective skill if one exists.
3. Draft the complete `SKILL.md` content with frontmatter.
4. Use `skill_write` with overwrite mode for coherent rewrites.
5. Read the skill back with `skill_read`.
6. Run a small trigger and behavior sanity check.
7. Tell the user where the skill was stored and what behavior changed.

Use append mode only for narrow additions that clearly belong at the end of an
existing custom skill.

Do not open a repo branch or PR for ordinary runtime custom skill work unless the
user explicitly asks to share the change back to the repo.

## Safety And Consent

Do not create skills that hide behavior from the user, bypass consent, exfiltrate
data, misuse credentials, impersonate people, or make dangerous actions easier.

For household skills, be especially careful with:

- credentials and logged-in sessions;
- purchases, orders, account changes, or payment methods;
- medical, legal, financial, or private personal data;
- messages sent into shared channels or rooms;
- durable memories about sensitive preferences or identities.

When a skill will make future Sandi more proactive, more persistent, or more
able to act in shared space, include the consent boundary in the skill.

## Final Report

When reporting skill work, keep it concrete:

- skill name and scope;
- what changed;
- whether any old behavior or trigger changed;
- validation performed;
- any follow-up needed for deployment or runtime synchronization.

If no follow-up is needed, say the skill is ready.
