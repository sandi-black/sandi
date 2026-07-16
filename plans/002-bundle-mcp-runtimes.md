# Plan 002: Ship MCP runtimes inside the Windows app

## Intent

Make the supported desktop MCP servers work from a fresh Sandi installation
without requiring Node, Python, uv, npm, npx, or server packages on the machine.
The same bundle must work in NSIS and portable builds, after relocation, and
without network access at first use.

This plan depends on Plan 001's bundled-command resolver and Electron-owned MCP
process lifecycle.

## Initial bundle

Use these tested pins as the first Windows x64 release baseline, updating them
only if implementation reveals a current compatibility or availability issue:

| Component           | Version |
| ------------------- | ------- |
| Node.js LTS         | 24.18.0 |
| uv                  | 0.11.29 |
| CPython             | 3.13.14 |
| Chrome DevTools MCP | 1.6.0   |
| Windows-MCP         | 0.8.2   |

Bundle both the runtimes and the curated server dependencies. Shipping only the
runtimes would still leave `npx` or `uvx` downloading packages on first use.

## Product contract

- A checked-in lock records immutable sources, versions, SHA256 hashes,
  licenses, target architecture, and stable command IDs.
- A build-time preparation step downloads and verifies artifacts, constructs a
  relocatable `resources/mcp` tree, and emits a manifest that hashes every
  regular file.
- Electron Builder packages that tree through `extraResources`. Runtime paths
  resolve from `process.resourcesPath`, never from the install location stored
  in user configuration.
- Supported command IDs include the runtime tools and the two curated servers.
  Curated server commands start their packaged payloads directly rather than
  invoking a package manager at runtime.
- Mutable cache, profile, and state stay under Electron's `userData`. The app
  does not modify system PATH, install global packages, or write machine-level
  runtime state.
- Windows-MCP's Python dependencies are packaged as relocatable site packages
  with a small launcher that resolves them relative to itself. Do not ship a
  build-machine virtual environment with embedded paths.
- The resolver verifies the files needed by a command before its first spawn
  and reports a useful packaging error when a component is missing or corrupt.
- Package notices include the licenses required by the bundled runtimes,
  dependencies, and servers.

## Milestones

### 1. Lock and prepare the runtime bundle

Add the runtime lock, curated npm and Python dependency locks, Windows-MCP
launcher, and preparation and verification scripts. Preparation should be
repeatable from a clean checkout and should atomically replace the staged bundle
only after every artifact and staged file passes verification.

Verify lock corruption failures, staged versions and hashes, offline startup,
and real MCP initialize plus `tools/list` for both curated servers. Review the
complete diff with fresh eyes, address findings, then commit the milestone.

### 2. Package and resolve bundled commands

Add the staged tree to both Windows package targets and implement the real
bundled-command registry behind Plan 001's resolver. The registry should expose
stable IDs, versions, executable paths, fixed argument prefixes, fixed
environment, and manifest identity for diagnostics.

Test resolution from relocated resource roots, missing and corrupt components,
paths containing spaces, and startup with machine runtimes removed from PATH
and package-network access blocked.

Build NSIS and portable artifacts, inspect their packaged resources, review the
complete diff with fresh eyes, address findings, then commit the milestone.

### 3. Gate releases and smoke installation lifecycle

Update the Windows packaging workflow to prepare and verify the bundle before
artifact upload, then smoke the packaged resources after Electron Builder runs.
Report component versions, manifest digest, and artifact sizes in the workflow
summary.

Exercise an NSIS install, update, uninstall, a portable relocation, offline
startup of both curated servers, and corrupt-file refusal. Document the bundle
layout, version update process, diagnostics, and cleanup in the desktop app
developer guide.

Run the full repository and app checks. Review the full Plan 002 diff with fresh
eyes, address findings, mark the plan done in the index, and commit.

## Acceptance criteria

- Fresh NSIS and portable installs can start Chrome DevTools MCP and Windows-MCP
  without system runtimes, global packages, or package downloads.
- Both artifacts contain the same verified `resources/mcp` payload and continue
  to work after install or portable relocation.
- Bundled command configuration stores stable IDs, while the resolver derives
  current executable paths from the running application resources.
- Every downloaded and packaged file is covered by checked-in provenance and
  build-time integrity verification, with required license notices included.
- Runtime and server writes stay in app-owned user data directories.
- A missing or corrupt bundled component fails before spawn with a useful
  diagnostic.
- The package workflow fails before artifact upload when preparation,
  verification, or packaged server smoke fails.

## Review focus

Review reproducibility, relocation, offline behavior, absence of machine-level
installation, package provenance, license coverage, and whether either curated
server can accidentally fall back to a network package manager.
