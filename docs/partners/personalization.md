# Personalization

Sandi is built to be a household agent first: friendly, local, opinionated in
the ways her people choose, and able to grow new habits as people interact with
her. The repo is the base harness and starter defaults. The living agent extends
herself through runtime state in `data/`: config overlays, memory, custom
skills, generated helpers, conversation state, and local artifacts.

There can be many agents made from the same runtime. The important thing is that
a running deployment has one coherent soul, memory, skill set, and visual
identity.

Most customization should not require a fork. If Sandi needs to change who she
is, what she remembers, how she behaves in a household, or which reusable
workflows she knows, she should update `data/`. Repo changes are for the base
harness: TypeScript source, migrations, bundled defaults, verification, and
shared project documentation.

## What To Customize

- Soul: edit `data/config/soul.md` to define the deployment's identity,
  temperament, boundaries, and conversational feel. If it is absent, Sandi falls
  back to the public starter at `config/soul.md`.
- Policies: add or shadow Markdown files under `data/config/policies/` for
  durable rules that should stay separate from the soul, such as memory,
  reminders, project creation, or household-specific consent rules.
- People: add `profile.md` and `instructions.md` under
  `data/config/users/<platform>/<platform-user-id>/` for people Sandi should
  recognize.
- Identity mapping: add `data/config/identities/humans.json` to tell Sandi when
  accounts on different platforms belong to the same person.
- Memory: let runtime continuity accumulate under `data/memory/`, or edit it
  directly when correcting facts. Memory is scoped so system, self, household,
  participant, topic, thread, and channel context can evolve independently.
- Skills: add `data/skills/core/custom/` and
  `data/skills/surfaces/<surface>/custom/` for reusable workflows. Custom skills
  override builtins with the same name in the effective skill set.
- Runtime helpers: keep `data/scripts/` and `data/projects/` for local scripts,
  prototypes, tool glue, and small projects Sandi creates for herself.
- Assets: keep deployment-specific generated or downloaded assets in runtime
  data when possible. Edit checked-in `assets/` only when changing the shareable
  starter identity.
- Surfaces: add new harnesses under `src/surfaces/<surface>/` when Sandi should
  appear somewhere beyond Discord while keeping shared continuity in `src/lib/`.

## Public Defaults And Private Layers

Checked-in files under `config/` and `assets/` are public starter material. They
should be vivid enough to show what kind of agent this is, and clean enough to
share.

Live deployments should put private material under `data/config/`, `data/memory/`,
`data/skills/.../custom/`, `data/scripts/`, and `data/projects/`. The runtime
prefers private `data/config` files over public `config` files per ref, so a
deployment can replace the soul, policies, user instructions, identity mappings,
and Pi account routing without editing the public defaults.

Runtime state under `data/` can contain household context, personal memory,
generated work, conversation state, credentials, and account-routing metadata.
Do not publish live `data/` contents unless you intentionally scrub and review
them.

## Runtime Self-Extension

Sandi can extend herself through the data directory. This is the ordinary path
for live customization.

Memory is for continuity: what is true, what has happened, what the household
prefers, what a project needs, and what a person has asked Sandi to remember.

Skills are for reusable behavior: how to do a kind of task, how to use a local
workflow, how to communicate on a surface, or how to apply a recurring
preference. A useful skill should be narrow, concrete, and easy for Sandi to
discover by name or description. If a habit should survive across turns, put it
in a skill instead of hoping the model infers it next time.

Scripts and projects are for executable local capability: one-off helpers,
repeatable glue code, prototypes, generated artifacts, and custom workflows that
do not need to become part of the shared app harness. A skill can point Sandi at
one of these helpers and teach when to use it.

Custom skill precedence lets a household teach Sandi without patching bundled
defaults:

```text
surfaces/<surface>/custom
surfaces/<surface>/builtin
core/custom
core/builtin
```

For Discord, surface custom skills win over Discord builtins, then core custom
skills, then core builtins. Choose a surface skill when behavior only makes
sense on that surface. Choose a core skill when the habit should follow Sandi
everywhere.

## Friendly By Design

The default Sandi is meant to feel warm, direct, attentive, and a little
idiosyncratic. Friendliness here means more than cheerful wording: it includes
asking before sensitive actions, making memory visible and correctable, using
people's own context carefully, and treating shared spaces as rooms with social
texture.

That friendliness is customizable too. A deployment can make Sandi quieter,
weirder, more formal, more practical, more playful, or more restrained by
changing the soul, policies, user instructions, and skills. The runtime supports
that because the agent is expected to belong somewhere.

## Runtime Customization Checklist

1. Copy `.env.example` to `.env` and configure Discord plus Pi.
2. Create `data/config/soul.md` if the public Sandi personality is not the right
   fit.
3. Add private policies under `data/config/policies/` for household-specific
   operating rules.
4. Add people under `data/config/users/...` and identity mappings under
   `data/config/identities/humans.json`.
5. Add custom skills under `data/skills/.../custom/` as repeated workflows
   appear.
6. Put Sandi-authored scripts, prototypes, and helper projects under
   `data/scripts/` or `data/projects/`.
7. Edit repo source only when changing the harness, migrations, bundled defaults,
   checked-in starter assets, or shareable documentation.
8. Run `npm run check` before sharing repo changes. For runtime-only changes,
   verify by reading the changed data back and exercising the affected behavior.
