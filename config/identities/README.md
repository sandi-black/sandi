# Identity Config

`humans.json` maps known humans across platform accounts. Runtime participant
state still records the platform-local account that spoke in a conversation;
this config is the explicit bridge for cases where Discord and GitHub accounts
belong to the same person.

Private deployments should put the live file at
`data/config/identities/humans.json`. The checked-in `humans.example.json` file
is a schema-shaped example and is not loaded automatically.

Use durable platform account IDs for important mappings. Usernames and logins
are allowed as bootstrap fallbacks, but they can change and should not be the
only key for a known human once the numeric platform ID is available.

Example mapping IDs in this repository are placeholders. Replace them with
durable platform account IDs in a private config overlay before enabling
identity-based routing.
