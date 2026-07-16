# Plan 003: Teach Sandi fast semantic Windows computer use

## Intent

Give Sandi a faster computer-use path by composing semantic desktop MCP calls
inside one code-mode run. Use Windows-MCP for native Windows UI, Chrome DevTools
MCP for page content, existing local tools for files and commands, and fresh
screenshots only when the target has no useful semantic interface.

This plan depends on the desktop MCP bridge in Plan 001 and the packaged Chrome
and Windows servers in Plan 002.

## Routing policy

| Target                                                    | Primary interface     |
| --------------------------------------------------------- | --------------------- |
| Native applications and system windows                    | Windows-MCP           |
| Web page content, forms, console, and network             | Chrome DevTools MCP   |
| Browser chrome, permission UI, and OS dialogs             | Windows-MCP           |
| Files, directories, commands, and development work        | Existing local tools  |
| Canvas, remote desktop, games, and inaccessible custom UI | Fresh screenshot path |

The normal execution loop is observe, act, wait on a semantic condition, and
verify. Put dependent calls in one `sandi_js_run` so routine GUI actions do not
pay for another parent-model turn. Search and describe only the tools needed,
use the live schema, keep returned state compact, and do not retry a mutating
action after an ambiguous transport failure.

Use a UI-focused Windows-MCP allowlist. The baseline needs semantic snapshot,
input, application selection, display inventory, screenshot fallback, and wait
operations; it does not need shell, filesystem, clipboard, process, registry, or
scraping capabilities already covered elsewhere.

Chrome uses the isolated packaged configuration by default. Connecting to an
existing profile is an explicit operator choice and still goes through Chrome's
own remote-debugging consent.

## Milestones

### 1. Add the computer-use skill and routing coverage

Create a builtin `computer-use` skill that explains setup, semantic routing,
the fast execution loop, verification after actions, screenshot fallback, and
the boundary around untrusted UI and web content. Include the recommended
bundled Windows-MCP and Chrome DevTools MCP configurations.

Add source-grounding checks showing that native Windows, Chrome, clicking,
typing, and GUI automation prompts find the skill while unrelated prompts do
not force it into context. Check representative dry runs for a native semantic
flow, a browser-only DevTools flow, and a justified visual fallback.

Run the relevant source-grounding, surface-boundary, MCP bridge, packaged
runtime, and app build checks. Review the complete diff with fresh eyes, address
findings, then commit the milestone.

### 2. Document, smoke, and benchmark the path

Add a focused developer guide covering configuration, routing, recovery,
multi-desktop behavior, browser profile choice, and why AutoIt is not in the
baseline. Link it from the existing desktop and surfaces guides without
duplicating the procedure.

Through the packaged app, verify configuration, the UI-only Windows tool catalog,
native observation and input, Chrome page interaction, routing across a browser
and an OS dialog, disabled-server behavior, and recovery after a desktop session
change. Keep the app and server under the same ordinary desktop user and confirm
the servers remain app-owned stdio children.

Benchmark warm native and browser tasks against the current screenshot-driven
path. Record wall-clock time, parent-model turns, MCP calls, screenshots, and
failures across repeated runs. The new default should reduce median time and
parent-model turns without increasing failures; use traces to correct the
existing loop if it does not.

Run `npm run check`, build the app, and run `git diff --check`. Review the full
Plan 003 diff with fresh eyes, address findings, mark the plan done in the index,
and commit.

## Acceptance criteria

- The builtin skill is discoverable for Windows and browser computer-use tasks
  on every Sandi surface.
- Native UI work uses Windows-MCP semantic state; page work stays in Chrome
  DevTools MCP; direct file and shell work stays in existing local tools.
- One code-mode run can perform and verify several dependent GUI actions without
  a parent-model turn between them.
- Screenshots are a fallback for visual or inaccessible targets rather than the
  normal observation path.
- The packaged curated servers start offline and expose only the capabilities
  needed by the routing policy.
- Existing-profile Chrome access requires explicit operator choice and Chrome
  consent.
- Benchmarks show lower median time and fewer parent-model turns without more
  failures.
- AutoIt remains a later option for a stable application workflow that semantic
  tools cannot operate reliably.

## Review focus

Review semantic-first routing, verification after mutation, handling of
untrusted UI content, ambiguity after transport failures, tool capability
scope, and whether the benchmarks measure the complete user-visible task.
