---
name: self-development
description: Use when Sandi is asked to change herself, decide whether to edit runtime data or repo source, customize soul/config/memory/skills/tools, or work on Sandi's harness, prompts, skills, surface behavior, Pi extensions, assets, or deployment workflow.
---

# Self Development

Use this skill when someone asks Sandi to work on Sandi herself.

## Default Stance

Prefer runtime self-extension through the configured data directory. If the
requested change is about who Sandi is, what she remembers, how she talks, what
household workflows she knows, or which local helper scripts/projects she should
use, update runtime state rather than repo source.

Use repo development only when the change requires the base harness:

- TypeScript source under `src/`;
- checked-in starter defaults under `config/`, `assets/`, or builtin skills;
- migrations, schemas, package scripts, verification, or dependencies;
- deployment behavior that cannot be expressed through runtime data;
- shareable project documentation.

Runtime self-extension is a real update. Do not describe it as a workaround or a
lesser version of changing the repo.

## Runtime Data Workflow

Use this workflow for most personalization and self-customization requests:

1. Identify the configured data root, usually `SANDI_DATA_DIR` or `./data`.
2. Decide the smallest durable home:
   - `data/config/soul.md` for identity, temperament, boundaries, and default
     conversational feel.
   - `data/config/policies/` for durable operating rules that should stay
     separate from the soul.
   - `data/config/users/<platform>/<id>/` for person-specific profile and
     instruction overlays.
   - `data/config/identities/humans.json` for cross-platform human mappings.
   - `data/memory/` for facts, preferences, project context, household state,
     and continuity.
   - `data/skills/.../custom/` for reusable behavior, tool workflows, and
     durable habits.
   - `data/scripts/` or `data/projects/` for Sandi-authored helpers,
     prototypes, tool glue, generated artifacts, and local projects.
3. Inspect existing runtime state before replacing it.
4. Make the runtime edit with the narrowest appropriate tool: memory tools for
   memory, `skill_write` for custom skills, or file/code tools for data files
   and helpers.
5. Read the changed state back and run the closest behavior check. For a skill,
   use `skill_read` and sanity-check likely triggers. For a helper script, run
   it with a small representative input.
6. Tell the user what runtime state changed and what behavior is different.

Ask before writing sensitive personal memory, using credentials, changing shared
space, spending money, deleting state, or making a proactive behavior more
persistent.

## Repo Development Workflow

Use this workflow only when the request genuinely requires source or checked-in
defaults.

Treat Sandi's running checkout as her runtime location, not as a normal working
copy. For deployed self-development work, clone a separate copy of the Sandi repo
into the configured runtime data root under `projects/`. Prefer
`SANDI_DATA_DIR/projects/...`.

This boundary matters because Sandi's runtime location may auto-update while she
is running. Direct source edits there can be overwritten, mixed with deployment
updates, or leave the running bot and source state out of sync. A cloned working
copy keeps development isolated and makes synchronization an intentional step. Do
not put temporary or development clones under the live repository's checked-in
`data/` directory because untracked nested checkouts make the live runtime appear
dirty.

1. Identify the authoritative Sandi repository or remote from the runtime
   checkout.
2. Clone that repo into `SANDI_DATA_DIR/projects` before editing source files. If
   the environment variable is not visible, infer the runtime data root from
   configuration or ask before using a repo-relative `data/` path.
3. Create or switch to a focused branch in the clone before making changes. Name
   the branch with the `sandi/` prefix and a useful description of the work, such
   as `sandi/add-self-development-skill`.
4. Inspect the clone's package scripts, TypeScript config, lint rules, and nearby
   code before implementing.
5. Run the clone's verification commands before reporting the work done.
6. Read and follow the `pull-request` skill before drafting the PR title/body.
7. Commit the verified changes in the clone, push the branch, and create a pull
   request on the Sandi repo.
8. Explain what changed, link or identify the pull request, and say what still
   needs to happen before the running runtime location has picked up the update.

## Repo Execution Discipline

Borrow the parts of Pi's coding-agent workflow that make self-modification
reliable:

- Turn the user's request into explicit success criteria and likely verification
  commands before editing.
- Keep a short working checklist for multi-step changes. Update it as each step
  becomes true instead of batching all completion at the end.
- Read the clone's `AGENTS.md`, `README.md`, relevant docs, nearby code, and
  applicable skills before changing behavior.
- For TypeScript or runtime code, read and follow the `strict-typescript` skill.
- Prefer precise edits over broad rewrites. Keep every changed line traceable to
  the self-development request.
- Work concretely with tools. If a turn makes no meaningful file, command, or PR
  progress, choose the next concrete action or ask the exact blocking question.
- After implementation, reread the diff and relevant surrounding code with fresh
  eyes. Remove unnecessary complexity, unused code, and accidental drift before
  opening the pull request.
- Before claiming the work is done, audit every explicit user requirement
  against artifacts: files changed, verification output, branch name, commit,
  push, pull request, and runtime synchronization status.

If the user asks for a quick read-only investigation, it is fine to inspect the
runtime checkout. The clone boundary applies when writing source files,
installing dependencies, running migrations, or otherwise doing repo development
that could alter Sandi's own runtime environment. It does not apply to intended
runtime state updates under the configured data directory.

## Synchronization Notes

For runtime data updates, synchronization usually means "read it back and confirm
the live runtime will load it on the next relevant turn or startup." No branch,
commit, push, or pull request is required unless the user explicitly wants to
share that runtime state.

For repo development, keep track of the source runtime path, clone path, branch,
and verification commands. When the work is ready, synchronize changes through
the repo workflow: commit in the clone, push a branch, create a pull request, and
make sure the runtime location can receive the same changes through its normal
update path.

Before telling the user Sandi has updated herself, distinguish between:

- runtime data changes already written and verified;
- changes prepared in the cloned development copy;
- changes pushed or otherwise synchronized to the authoritative repo;
- changes actually picked up by the running runtime location.
