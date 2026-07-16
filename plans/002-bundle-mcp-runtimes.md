# Plan 002: Ship MCP runtimes inside the Windows app

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Dependency and drift check (run first)**:
> `git diff --stat 0565d5a..HEAD -- .gitignore package-lock.json .github/workflows/package.yml app/package.json app/electron-builder.yml app/src/main/index.ts app/src/main/mcp app/scripts docs/developers/desktop-app.md plans/README.md`
> Plan 001 must be marked DONE. Changes made by Plan 001 under
> `app/src/main/mcp` and `app/src/main/index.ts` are expected; compare them with
> the dependency contract below. Any unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 001
- **Category**: direction
- **Planned at**: commit `0565d5a`, 2026-07-15

## Why this matters

The generic bridge in Plan 001 can start a desktop MCP server, but an external
`npx` or `uvx` command still assumes the user's machine has the right package
manager and runtime. It can also download a different dependency graph on the
first tool call. That makes a fresh Sandi install incomplete, slows the first
computer-use turn, and lets an app update leave old machine-level runtimes
behind.

Both Windows artifacts should carry the runtimes and curated MCP server
payloads that Sandi supports out of the box. The desktop host resolves stable
command IDs from `process.resourcesPath`; config survives NSIS updates and
portable relocation, and uninstalling or replacing Sandi replaces the runtime
payload with it. The same registry can expose package runners for a future MCP,
but the curated Chrome and Windows servers must start without installing or
downloading anything.

## Dependency contract

Plan 001 must provide:

- A `DesktopMcpServerConfig.command` union with
  `{ kind: "external", executable: string }` and
  `{ kind: "bundled", id: string }` forms.
- Injection of a bundled-command resolver into the Electron MCP host.
- Failure before spawn for an unknown or unavailable bundled ID.
- Approval text that shows the bundled ID, component version, resolved
  executable, fixed argument prefix, manifest digest, proposed arguments, and
  inherited environment names.
- The same stdio lifecycle, cancellation, catalog, result, and logging behavior
  for external and bundled commands.

This plan supplies the production resolver and resources. Do not replace the
command union with paths copied from the current install directory. Do not add
an installer action that modifies system `PATH`, the Python registry, npm's
global prefix, or a user-level runtime installation.

## Current state

- `app/electron-builder.yml:27-34` includes only `out/**` and keeps
  `node_modules` out of the artifact. It has no `extraResources` entry.
- `app/electron-builder.yml:37-49` builds both NSIS and portable Windows
  targets from the same application payload.
- `app/electron.vite.config.ts` bundles JavaScript imported by Sandi's main,
  preload, and renderer processes. It cannot bundle standalone executables or
  third-party Python environments into `out/`.
- `.github/workflows/package.yml:89-99` builds the Electron bundles and calls
  `electron-builder` directly on `windows-latest`. This is the only current
  Windows packaging gate.
- `app/package.json` has no runtime preparation, lock verification, packaged
  payload verification, or archive extraction script.
- `.gitignore` ignores `app/build/icons/` but has no entry for a generated MCP
  runtime staging directory.
- Electron-builder copies `extraResources` outside `app.asar` into the packaged
  `resources` directory, where the app can resolve them through
  `process.resourcesPath`:
  <https://www.electron.build/docs/contents/>.

The initial Windows x64 bundle is pinned to these components:

| Component           | Version | Distribution source                                         |
| ------------------- | ------- | ----------------------------------------------------------- |
| Node.js LTS         | 24.18.0 | <https://nodejs.org/download/release/v24.18.0/>             |
| uv                  | 0.11.29 | <https://github.com/astral-sh/uv/releases/tag/0.11.29>      |
| CPython             | 3.13.14 | uv-managed Astral `python-build-standalone` distribution    |
| Chrome DevTools MCP | 1.6.0   | <https://www.npmjs.com/package/chrome-devtools-mcp/v/1.6.0> |
| Windows-MCP         | 0.8.2   | <https://pypi.org/project/windows-mcp/0.8.2/>               |

Node 24 is an active LTS line and satisfies Chrome DevTools MCP's Node engine
range. uv supports a fixed managed CPython version and an app-local
`UV_PYTHON_INSTALL_DIR`; it uses the self-contained Astral distributions rather
than a machine Python. uv and CPython are included as application components,
not installed for the user.

## Target bundle layout

The packaging script produces this ignored staging tree:

```text
app/build/mcp-runtime-bundle/win32-x64/
  manifest.json
  licenses/
  runtimes/
    node/
      node.exe
      node_modules/npm/...
    python/
      ...
  tools/
    uv/
      uv.exe
      uvx.exe
  servers/
    chrome-devtools-mcp/
      node_modules/...
      package.json
      package-lock.json
    windows-mcp/
      launch.py
      site-packages/...
      pyproject.toml
      uv.lock
```

Electron-builder copies that tree to `resources/mcp/` in the unpacked app and
both installers. Program files are read-only. Runtime caches, browser profiles,
logs, and temporary files belong under `app.getPath("userData")`, never under
`process.resourcesPath`.

`manifest.json` is generated from the checked-in lock and records the target,
component versions, relative executable paths, fixed argument prefixes, fixed
environment templates, license paths, and SHA-256 for every regular file. It is
a packaging-integrity check. Since the Windows artifacts are still unsigned,
it does not establish tamper resistance; do not describe it as a signature or
trust root.

## Commands you will need

| Purpose                    | Command                                                                              | Expected on success                                      |
| -------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Update app dependencies    | `npm install -D extract-zip -w app`                                                  | exit 0; app manifest and root lockfile updated           |
| Validate checked-in locks  | `npm run verify:mcp-runtime-lock -w app`                                             | exit 0; pins, hashes, licenses, and command IDs validate |
| Prepare Windows x64 bundle | `npm run prepare:mcp-runtimes -w app -- --platform win32 --arch x64`                 | exit 0; staging tree and manifest created                |
| Verify staged bundle       | `npm run verify:mcp-runtime-bundle -w app -- app/build/mcp-runtime-bundle/win32-x64` | exit 0; hashes, versions, and server catalogs pass       |
| Package both targets       | `npm run package -w app`                                                             | exit 0; NSIS and portable artifacts produced             |
| Verify packaged resources  | `npm run verify:packaged-mcp-runtimes -w app -- app/release/win-unpacked`            | exit 0; packaged commands start and list tools           |
| App gate                   | `npm run check -w app`                                                               | exit 0                                                   |
| Full gate                  | `npm run check`                                                                      | exit 0                                                   |

The exact script argument separator may need to match npm's forwarding behavior
on Windows. Fix the documented command and package scripts together if the
current npm version requires a different form.

## Suggested executor toolkit

- Use the `code-craft` skill if available for the lock schema, path containment,
  resolver, and verification scripts.
- Use the `one-feature-one-file` skill if available for the runtime resolver and
  its checks. Keep the existing MCP host modules focused on process lifecycle.
- Use the `stop-slop` skill for packaging comments, license notices, and the
  developer guide.
- Read Electron-builder's `extraResources` documentation:
  <https://www.electron.build/docs/contents/>.
- Read uv's managed Python and no-download documentation:
  <https://docs.astral.sh/uv/concepts/python-versions/>.
- Review the upstream licenses before redistribution. Node ships its license
  and dependency notices; CPython uses the PSF license; uv is dual MIT or
  Apache-2.0; each curated MCP server and every included package must retain its
  applicable notice.

## Scope

**In scope** (the only existing files you should modify):

- `.gitignore`
- `package-lock.json`
- `.github/workflows/package.yml`
- `app/package.json`
- `app/electron-builder.yml`
- `app/src/main/index.ts`
- `app/src/main/mcp/**`
- `docs/developers/desktop-app.md`
- `plans/README.md` (status only)

**In scope** (new files and directories you may create):

- `app/mcp-runtime-lock.json`
- `app/mcp-runtime-NOTICES.md`
- `app/mcp-servers/chrome-devtools/package.json`
- `app/mcp-servers/chrome-devtools/package-lock.json`
- `app/mcp-servers/windows-mcp/pyproject.toml`
- `app/mcp-servers/windows-mcp/uv.lock`
- `app/mcp-servers/windows-mcp/launch.py`
- `app/scripts/prepare-mcp-runtime-bundle.mjs`
- `app/scripts/verify-mcp-runtime-lock.mjs`
- `app/scripts/verify-mcp-runtime-bundle.mjs`
- `app/scripts/verify-packaged-mcp-runtimes.mjs`

**Out of scope** (do not touch):

- Pi, the server-side broker, device protocol, result model, or code-mode API.
- A runtime downloader in the installed app. Downloads occur only on a build
  machine while preparing a release.
- Machine-level installers, MSI chaining, registry writes, `PATH` edits,
  global npm packages, global uv tools, or a user Python installation.
- macOS, Linux, Windows x86, or Windows ARM64 runtime assets. The current
  packaging workflow emits Windows x64 artifacts; add another target only with
  its own locked payload and packaged smoke job.
- Automatic MCP server updates. Curated server, runtime, and dependency changes
  ship as a Sandi application release.
- A general plugin marketplace or arbitrary runtime download policy.
- Code signing. Keep the existing unsigned-artifact warning accurate.
- Bundling Chrome itself. Sandi ships the Chrome DevTools MCP server and Node;
  the optional browser integration still requires an installed Chrome.

## Git workflow

- Branch: continue the branch that completed Plan 001, or create
  `codex/bundled-mcp-runtimes` if Plan 001 was already merged.
- Commit the lock inputs and preparation scripts together, the runtime resolver
  and packaging integration together, then docs and verification evidence.
- Append the required `Co-authored-by: Codex <noreply@openai.com>` trailer to
  commits materially authored or verified by Codex.
- Do not push or open a pull request unless the operator asks.

## Steps

### Step 1: Define one checked-in runtime and server lock

Create `app/mcp-runtime-lock.json` with a Zod-validated schema version, target
`win32-x64`, and the five pinned components in "Current state". Every downloaded
archive entry contains an HTTPS URL, exact version, SHA-256, archive type,
extraction root, upstream project URL, and license source. URLs must point to an
immutable versioned release, never a `latest` alias.

Add a command registry section with these stable IDs:

- `node`: packaged `node.exe`.
- `npm`: packaged Node plus npm's `npm-cli.js` as a fixed argument prefix.
- `npx`: packaged Node plus npm's `npx-cli.js` as a fixed argument prefix.
- `python`: packaged CPython executable.
- `uv`: packaged `uv.exe`, constrained to the packaged Python directory and an
  app-owned cache.
- `chrome-devtools-mcp`: packaged Node plus the locked server's declared bin
  entrypoint.
- `windows-mcp`: packaged Python plus the server's resource-relative bootstrap
  as a fixed argument prefix.

Command entries use relative paths only. The schema rejects absolute paths,
parent traversal, empty components, duplicate IDs, unsupported target values,
missing digests, mutable URLs, and fixed environment keys outside an explicit
runtime-owned list.

Create the two dependency projects:

- `app/mcp-servers/chrome-devtools/package.json` has one exact production
  dependency, `chrome-devtools-mcp: "1.6.0"`. Generate and commit its npm lock.
- `app/mcp-servers/windows-mcp/pyproject.toml` is a private application with
  `requires-python == 3.13.*` and one exact dependency,
  `windows-mcp == 0.8.2`. Generate and commit its uv lock with uv 0.11.29.

Do not hand-edit transitive dependencies. npm integrity values and uv hashes
must cover every resolved package. Refuse a source distribution or package
install script in either curated server unless the executor reports why the
published binary/package cannot be prepared without it and gets a new design
decision. The baseline accepts wheels and ordinary JavaScript packages only.

Create `app/mcp-runtime-NOTICES.md` listing each top-level component, version,
project URL, license, and the packaged path containing its full license text.
The preparation script also gathers dependency license files into the staging
tree. A missing or unknown license fails preparation.

Add `verify:mcp-runtime-lock` to `app/package.json` and the app `check` sequence.
It validates only checked-in files and makes no network request, so Linux PR
checks can run it.

**Verify**: `npm run verify:mcp-runtime-lock -w app` -> exit 0. Corruption tests
inside the verifier must reject a changed version, digest, URL, path traversal,
duplicate command ID, missing license, npm lock mismatch, uv lock mismatch, and
unpinned direct dependency.

### Step 2: Prepare the bundle only on the packaging machine

Create `app/scripts/prepare-mcp-runtime-bundle.mjs`. It accepts an explicit
platform and architecture, reads the checked-in lock, and writes only to
`app/build/mcp-runtime-bundle/<platform>-<arch>`. Add that generated root to
`.gitignore`.

The script performs this ordered build:

1. Create a new temporary staging sibling. Refuse to reuse a partial tree.
2. Download each immutable archive, cap response and extracted sizes, verify
   SHA-256 before extraction, and reject archive entries that are absolute,
   traverse upward, use links, or escape their component directory.
3. Extract Node 24.18.0 and uv 0.11.29. Preserve Node's bundled npm files and
   all upstream license material.
4. Use the pinned uv binary with `UV_PYTHON_NO_REGISTRY=1`, an explicit staging
   `UV_PYTHON_INSTALL_DIR`, and the exact CPython 3.13.14 request. Disable system
   Python discovery. Capture the resolved python-build-standalone build identity
   in the generated manifest and verify it against the lock.
5. Run `npm ci --omit=dev --ignore-scripts` in a staging copy of the Chrome
   dependency project using the packaged Node/npm. Use a staging npm cache.
   Confirm the installed package version and bin entrypoint match the lock.
6. Export a hash-locked requirements set from the Windows-MCP uv lock, then
   install it with the packaged Python into
   `servers/windows-mcp/site-packages`. Disable Python downloads, system Python,
   source builds, and project discovery outside the dependency project. Do not
   create or ship a virtual environment: Windows venv launchers and
   `pyvenv.cfg` can retain build-machine paths and are not the relocation
   boundary for this app.
7. Copy the checked-in `launch.py` beside that package directory. It resolves
   `site-packages` relative to its own location, calls `site.addsitedir` so
   package `.pth` files and native dependencies initialize normally, and runs
   `windows_mcp` as `__main__` while preserving the server arguments. Confirm
   the imported package version and MCP startup after moving the entire staging
   root to a different absolute path.
8. Copy required licenses and the checked-in notices, then generate
   `manifest.json` from the files that will actually ship.
9. Verify the complete temporary tree, atomically replace the final staging
   directory, and remove the temporary tree on failure.

Do not place network caches, build logs, Python bytecode caches, or temporary
download archives in the final bundle. Normalize timestamps only if it is
required to make repeated preparation byte-for-byte identical; document the
source timestamp used. Run preparation twice and compare manifests and file
hashes. They must match.

Add `prepare:mcp-runtimes` and `verify:mcp-runtime-bundle` scripts to
`app/package.json`. The ordinary `build` and `check` commands must not download
or prepare Windows assets. The `prepackage` lifecycle runs preparation before a
local `npm run package -w app`.

**Verify**:
`npm run prepare:mcp-runtimes -w app -- --platform win32 --arch x64 && npm run verify:mcp-runtime-bundle -w app -- app/build/mcp-runtime-bundle/win32-x64`
-> exit 0. Run the preparation command again and confirm the manifest and all
recorded hashes are unchanged.

### Step 3: Package resources and resolve stable bundled commands

Add this application resource mapping to `app/electron-builder.yml`:

```yaml
extraResources:
  - from: build/mcp-runtime-bundle/win32-x64
    to: mcp
    filter:
      - "**/*"
```

Do not put executable resources inside `app.asar`. Keep `npmRebuild: false` and
the current `out/**` app bundle rule.

Implement the production bundled-command resolver under
`app/src/main/mcp/`. It loads `resources/mcp/manifest.json` in a packaged app
and accepts an injected resource root in tests. Resolve every path with
containment checks under that root, reject symlinks/reparse-point escapes, and
verify every file used by the selected command before its first spawn. Cache
only a successful component verification for the current app process.

The resolver returns:

```ts
type ResolvedBundledCommand = {
  id: string;
  componentVersion: string;
  executable: string;
  argsPrefix: string[];
  fixedEnv: Record<string, string>;
  manifestDigest: string;
};
```

The checked-in manifest schema may mark fixed arguments as resource-relative
paths. The resolver expands those entries under the verified resource root and
returns ordinary absolute strings in `argsPrefix`; config and the model never
provide or persist those paths.

Fixed environment values are created by trusted app code. They may contain the
current resource root and app-owned cache root but never values received from
the model or persisted config. Use separate directories under
`app.getPath("userData")/mcp-runtime/` for npm cache, uv cache, temporary files,
and server state. Give each curated command an app-owned home so its default
config, cache, and browser-profile paths cannot land beside the executable or in
the user's general home. Set Python to avoid bytecode writes in resources.
Constrain uv to packaged CPython, disable automatic Python downloads, and
disable registry registration. Disable Windows-MCP anonymous telemetry through
its trusted fixed environment. Curated program IDs bypass npm, npx, uv, and
uvx at runtime.

Wire this resolver into the Plan 001 MCP host in `app/src/main/index.ts`.
Development builds report bundled commands unavailable unless the developer
explicitly supplies a prepared resource root; they do not fall back to system
`PATH`.

Extend the MCP host verification for:

- stable ID resolution after changing the injected absolute resource root;
- exact fixed argument prefix and fixed environment merge;
- unknown ID, wrong target, missing file, wrong hash, traversal, and reparse
  escape failure before spawn;
- userData cache paths outside resources;
- config replacement across a simulated app update without rewriting
  `mcp.json`;
- Windows-MCP package import and startup after relocating the injected resource
  root, proving that no virtual-environment build path remains;
- no logged fixed environment values or absolute user paths.

**Verify**:
`npm run verify:mcp-runtime-bundle -w app && npm run verify:mcp-host -w app && npm run verify:link-manager -w app`
-> exit 0.

### Step 4: Make the Windows release gate prepare and test the payload

Update `.github/workflows/package.yml` after `npm ci` and before the Electron
build to run lock verification and Windows x64 runtime preparation. Keep
version stamping independent; runtime component versions come from their own
lock, not the Sandi tag.

After `electron-builder`, run the packaged-runtime verifier against
`app/release/win-unpacked`. It must:

1. Load the packaged manifest through the same resolver used by the app.
2. run `node --version`, `python --version`, and `uv --version` through their
   bundled IDs and compare exact output with the lock;
3. start `chrome-devtools-mcp` and `windows-mcp` through stdio, complete MCP
   initialization, list all tool pages, and close both cleanly;
4. assert the two curated commands do not invoke npm, npx, uv, or uvx;
5. point package caches at empty temporary directories and fail if the smoke
   creates a package or Python download there;
6. check required license files and notices in packaged resources;
7. inspect both NSIS and portable artifact metadata and confirm the same
   runtime manifest digest is included.

The workflow must fail before artifact upload if preparation or packaged smoke
fails. Continue uploading only the current installer, portable executable,
blockmaps, and `latest.yml`; the runtimes live inside those application
artifacts.

Record the unpacked runtime size, NSIS size, portable size, and blockmap size in
the workflow summary. Do not add a size cap without a product decision, but make
growth visible in every packaging run.

**Verify**: run the `Package` workflow through `workflow_dispatch`. It must
produce both Windows executables, pass packaged server initialization, upload
the artifact set, and show the component versions, manifest digest, licenses,
and size report in the job summary.

### Step 5: Smoke install, portable relocation, offline startup, and update

Update `docs/developers/desktop-app.md` with the bundle layout, checked-in lock,
preparation command, runtime resolver, cache locations, license handling,
version upgrade procedure, and package workflow checks. State plainly that the
integrity manifest detects packaging drift but the current unsigned installer
does not prevent local tampering.

On a Windows x64 machine with no Node, Python, uv, npm, or npx on `PATH`:

1. Install the NSIS artifact to a non-default directory, launch Sandi, and
   confirm all seven bundled command IDs report their pinned versions.
2. Configure the two curated server IDs, approve their exact manifests, list
   each tool catalog, and make one harmless call while network access is
   disabled. No package setup prompt or download may occur.
3. Quit Sandi and confirm no MCP, Node, Python, or uv child remains.
4. Uninstall Sandi and confirm the application runtime resources are removed.
   Keep userData and its MCP config according to the app's existing uninstall
   policy; do not invent data deletion behavior in this plan.
5. Run the portable executable from a directory with spaces, configure both
   servers, then move the executable and launch again. Existing `mcp.json`
   bundled command IDs must still resolve without rewriting config.
6. Install an older build, configure both bundled IDs, then update through
   electron-updater. Confirm the new release replaces runtimes and curated
   server payloads atomically and the same config resolves the new manifest.
7. Corrupt one copied executable in a disposable unpacked build and confirm the
   resolver refuses it before spawn with a concise diagnostic.

Apply the stop-slop pass to all durable prose. Run
`npm run check && npm run package -w app && git diff --check` -> all exit 0.

## Test plan

- Add checked-in lock validation for versions, immutable URLs, SHA-256 values,
  relative paths, target, command IDs, dependency locks, and licenses.
- Test archive extraction against traversal, absolute paths, links, oversized
  content, a wrong digest, partial downloads, and atomic replacement.
- Prepare twice and compare every generated manifest entry and file hash.
- Extend the Plan 001 MCP host tests for stable bundled IDs, fixed prefixes and
  environments, path containment, hash verification, update relocation, and
  failure before spawn.
- Run real stdio initialization and tool listing for both packaged curated
  servers in the Windows package workflow.
- Smoke NSIS, portable relocation, no-system-runtime startup, offline curated
  server startup, app update, uninstall, and corrupt-resource refusal.
- Run the full root and app checks after targeted checks pass.

## Done criteria

- [ ] Plan 001 is marked DONE and its bundled-command dependency contract is
      present.
- [ ] The checked-in lock pins Node 24.18.0, uv 0.11.29, CPython 3.13.14,
      Chrome DevTools MCP 1.6.0, Windows-MCP 0.8.2, immutable source URLs,
      dependency locks, hashes, and licenses.
- [ ] Ordinary `npm run check` makes no runtime download and passes on Linux.
- [ ] Runtime preparation is Windows x64 only, rejects unsafe archives, uses no
      system runtime, and produces identical file hashes on two runs.
- [ ] Both NSIS and portable artifacts contain the same `resources/mcp`
      manifest, runtimes, curated servers, and license material.
- [ ] `mcp.json` stores stable bundled IDs, never paths under the current
      `process.resourcesPath`.
- [ ] The production resolver contains every resolved path, verifies the
      selected payload before spawn, and keeps writable state under userData.
- [ ] Curated Chrome and Windows MCP servers initialize and list tools offline
      without invoking npm, npx, uv, uvx, or a machine-level runtime.
- [ ] NSIS install, uninstall, app update, portable relocation, and corrupt-file
      refusal pass the Windows smoke.
- [ ] The package workflow fails before upload on a lock, preparation,
      licensing, manifest, or real-server smoke failure.
- [ ] The package workflow reports component versions, manifest digest, and
      artifact sizes.
- [ ] `npm run check`, `npm run package -w app`, and `git diff --check` exit 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` marks Plan 002 DONE.

## STOP conditions

Stop and report if any condition occurs:

- Plan 001 is not DONE or its bundled-command resolver contract differs
  materially from this plan.
- A pinned archive lacks an immutable URL, verifiable SHA-256, redistribution
  license, or required third-party notices.
- Chrome DevTools MCP requires an npm install script or Windows-MCP requires a
  source build to produce the pinned Windows x64 payload.
- CPython preparation writes to the Windows registry, reads a system Python, or
  cannot be constrained to the staging directory.
- Windows-MCP packages or native extensions cannot run from the relocated
  app-local `site-packages` layout without a build-machine path.
- A curated server needs to write into its packaged program directory.
- Electron-builder omits `extraResources` from either NSIS or portable output.
- The portable launcher does not expose a stable extracted
  `process.resourcesPath` for child executables.
- A real curated server cannot initialize and list tools with package caches
  empty and package-network access unavailable.
- Supporting Windows ARM64 or another platform becomes a release requirement.
  Add a separately locked and tested target rather than emulating it silently.
- The final artifact exceeds GitHub's release-asset limit or electron-updater
  cannot produce a valid blockmap for it.
- A step's verification fails twice after one reasonable correction.
- The implementation needs a file outside the declared scope.

## Maintenance notes

- Runtime and curated server upgrades are Sandi release changes. Update the
  top-level component lock, dependency lock, licenses, compatibility smoke, and
  notices together.
- Keep curated program IDs on direct entrypoints. Package-runner IDs exist for
  future approved MCP configuration, but using `npx` or `uv` at runtime gives
  up the offline and fixed-dependency properties of a curated command.
- Add one target directory and one package job per new operating-system and
  architecture pair. Never share native Python environments across targets.
- The package manifest and hashes catch damaged or incomplete artifacts. Code
  signing is the separate mechanism that will eventually authenticate the
  installer and update payload.
- Reviewers should scrutinize archive extraction, path containment, fixed
  runtime environment values, dependency-lock enforcement, licenses, no system
  installation, portable relocation, and real offline server startup.
