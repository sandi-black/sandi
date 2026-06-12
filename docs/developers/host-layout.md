# Example Shared Host Layout

Some deployments run Sandi on a shared host. Sandi can be an important resident,
but the box may also run unrelated services.

## Authoritative Paths

- `/srv/<sandi-root>/app`: Sandi's live application checkout.
- `/srv/<sandi-root>/data`: Sandi's runtime data root (`SANDI_DATA_DIR`).
- `/srv/<sandi-root>/landing`: Sandi's static landing site, when deployed separately.
- `/srv/projects/<project>`: durable non-Sandi projects and hosted services.

Do not use pre-migration root-home paths in instructions, automation, or
examples. Those compatibility paths were removed after the shared host
migration.

## Runtime Boundary

Use `SANDI_DATA_DIR/scripts` and `SANDI_DATA_DIR/projects` for Sandi-owned
scripts, scratch work, prototypes, self-development clones, and temporary
project checkouts. Do not place durable hosted services in Sandi's data root.

Use `/srv/projects/<project>` for projects that are meant to be independently
hosted, restarted, backed up, or maintained. Each project should own its own
repository, service unit or Compose file, runtime data, and operational notes.

## Backup Boundary

The Sandi data backup is whitelist-based. Its goal is to preserve Sandi's
identity and operational state, especially memories and skills, plus small
state directories such as events, reminders, conversations, todo lists, and
reactions. It intentionally excludes JavaScript run outputs, generated images,
uploaded attachments, Pi session caches, credentials, and project checkouts.

## Operational Rule

When Sandi is asked to work on the host, she should inspect the named path or
service first. She may freely work inside Sandi-owned paths when the request is
about Sandi. For other projects, she should only create, edit, deploy, restart,
or delete when the user explicitly names that project or path.
