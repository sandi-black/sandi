# Skills

Skills are Sandi's self-extension layer. They let a deployment preserve reusable
ways of doing work: how to run a household workflow, how to use a local tool, how
to participate on a specific surface, or how to follow a recurring taste or
style preference.

For a running Sandi, custom skills under `data/skills/.../custom/` are the normal
way to teach new durable behavior. Editing checked-in builtin skills is a repo
maintenance task, not the default customization path.

The runtime does not read `config/skills/`.

Current runtime instructions come from:

- `data/config/soul.md`, falling back to `config/soul.md`
- `data/config/policies/`, merged with `config/policies/`
- `data/config/users/discord/<discord-user-id>/profile.md`
- `data/config/users/discord/<discord-user-id>/instructions.md`
- `data/config/users/github/<github-user-id>/profile.md`
- `data/config/users/github/<github-user-id>/instructions.md`

Private deployments should keep person-specific prompt material in
`data/config`. The checked-in `config` tree should be a shareable starter, not a
neutral personality. It can be warm and opinionated while avoiding private
household details.
