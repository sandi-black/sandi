# Sandi

Sandi is a personalized, self-extending household agent named after the sand
that becomes silicon and powers the processors behind modern AI. She is meant to
feel friendly, specific, and local to the people who live with her: a bot with a
memory, a temperament, a home, and tools she can grow into over time.

Sandi is not a neutral corporate default. The checked-in personality and
character assets are a reference household agent: warm, practical, a little
uncanny, and designed to be replaced, remixed, or extended by each deployment.
There can be many agents built from this project. The point is that this one
becomes yours.

## What Sandi Does

The current primary surface is Discord. In a Discord server, Sandi can:

- keep persistent conversations in forum posts, standing channel rooms, and
  existing Sandi-managed threads;
- remember useful context about the household, people, topics, and
  conversations;
- work from reusable skills for recurring workflows;
- follow local operating policies;
- create scheduled events and interactive reminders;
- create and manage interactive todo lists;
- react to Discord replies, reactions, channel topics, and thread context;
- generate images through her configured model route;
- grow new runtime helpers, scripts, and custom skills as people interact with
  her.

Sandi is file-backed by design. A live deployment can change her soul, memory,
skills, policies, user preferences, generated helpers, and local state without
turning those private details into public source code.

## How People Interact With Her

In Discord:

- create a post in Sandi's forum channel to start a conversation;
- mention Sandi in a standing text channel to create or resume that channel's
  room conversation;
- run `/sandi help` to see the available commands;
- run `/sandi todo` to create a pinned interactive todo list;
- run `/sandi status` to inspect runtime health;
- run `/sandi events list` and `/sandi reminders list` to inspect scheduled
  work.

Sandi's Discord conversations are persistent. She can carry continuity across
turns, update her memory when something should last, and keep separate context
for different people, topics, channels, and threads.

## Personalizing Sandi

Sandi is designed to become specific. A deployment can give her a different
soul, different boundaries, different visual identity, different memories,
different reusable skills, and different preferences for the people she lives
with.

Most personalization belongs in private runtime data rather than in the public
starter defaults. That keeps the shareable Sandi harness clean while letting a
live Sandi grow into her own household.

See [Personalizing Sandi](docs/partners/personalization.md) for the
customization model and runtime self-extension workflow.

## Documentation

- [Sandi for partners](docs/partners/README.md): day-to-day interaction,
  Discord commands, memory, reminders, todo lists, and personalization.
- [Sandi for developers](docs/developers/README.md): local setup, deployment,
  runtime architecture, Pi integration, code mode, surfaces, and checks.

## License

Sandi is open-source application code. The npm package is marked private because
this repository is not intended to be published as a library package.

Unless a file or directory says otherwise, software and runtime material are
licensed under AGPL-3.0-or-later, and documentation, images, sprites, visual
assets, and other creative material are licensed under CC-BY-SA-4.0. See
[LICENSE](LICENSE), [LICENSES/CC-BY-SA-4.0.txt](LICENSES/CC-BY-SA-4.0.txt), and
[NOTICE](NOTICE) for details.
