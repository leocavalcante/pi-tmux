# Contributing

## Development

### Setup

Development uses [Bun](https://bun.sh/docs/installation) 1.4.4 for dependencies, scripts, and most tests, and Node.js 22.19 or newer, which Pi runs extensions on. `bun run test` runs both lanes: Bun's test runner for `tests/*.test.ts`, then Node's native test runner for `tests/*.node-test.ts`.

```sh
git clone https://github.com/leocavalcante/pi-tmux.git
cd pi-tmux
bun install --frozen-lockfile
```

To try the checkout in Pi without changing your settings:

```sh
pi -e ./src/extension.ts
```

Use either the installed package or the development extension, not both.

### Checks

Run the local validation gates used by CI—formatting, TypeScript checks for the
extension and tests, both test lanes, the package check, and the high-severity
dependency audit—with one command:

```sh
bun run verify
```

The individual scripts remain available when you only need a targeted check.
`bun run lint` runs Prettier and ESLint (typescript-eslint `strictTypeChecked`),
and `bun run format` applies their fixes. Disable a rule only on the line that
needs it, with a reason. Tests may also relax the unsafe-any, explicit-`any`,
non-null-assertion, and `require-await` rules, because they drive dynamic
package, subprocess, and protocol payloads. `bun run verify` stops at the first
failure. It does not include Gitleaks; install
it separately to run the secret scans under [Before submitting](#before-submitting).

`src/extension.ts` is the Pi entry point, named by `package.json` `pi.extensions`; the root `index.ts` re-exports it with the public helpers that tests use. The implementation lives in focused modules: `src/title.ts` handles title formatting, `src/naming.ts` handles model configuration and context, `src/tmux.ts` owns tmux formats and command adapters, `src/controller.ts` owns per-instance state and updates, and `src/extension.ts` registers commands and lifecycle events. The window snapshot is tab-delimited and its last field can be empty; preserve its trailing tab and remove only tmux's line terminator. Injected `RunTmux` adapters retain flat command arrays by default; adapters that support the server-PID guard can opt in with `supportsServerPidGuard = true`.

### Tests

Run both test lanes:

```sh
bun run test
```

- `bun run check` type-checks `index.ts` and `src/` with `noUncheckedIndexedAccess`, then every file under `tests/` with Bun and Node.js types, and the CI scripts; CI runs this check.
- `tests/load.node-test.ts` loads the extension under Node.js through jiti, as Pi does, and checks the commands and lifecycle hooks it registers.
- `tests/title.test.ts` covers formatting, context bounds and exclusions, naming cancellation, model configuration, empty window-name fields, status-only mode, explicit retries, manual pins, read-only diagnostics, model-free sync, truthful confirmations, lifecycle events, waiting markers, and failures with mock model responses and tmux commands.
- `tests/session.test.ts` checks window and session aggregation, shared-window ownership, concurrent status and ownership changes at rename time, and pane moves against a separate temporary tmux server with no user configuration. Its command wrapper strips only the final line ending so trailing spaces in literal tmux names remain observable in assertions. It skips if tmux is unavailable.
- `tests/move.test.ts` checks former-location marker repair, remaining peers, custom names, vanished targets, repeated moves, explicit sync retries, superseded repairs, and a server restart between lookup and write with reused numeric IDs on isolated tmux servers. Those checks skip if tmux is unavailable; the queue and stabilization bounds also have a mock-only regression.
- `tests/status.test.ts` verifies read-only diagnostic snapshots and waiting-flag aggregation on an isolated tmux server. It skips if tmux is unavailable.
- `tests/package.test.ts` runs `npm pack` in a temporary directory, inspects the packed manifest and entrypoint, then imports the extracted file after Bun's TypeScript erasure and exercises status-only lifecycle behavior without a runtime SDK dependency. It requires `npm` and `tar` on `PATH`; on Windows the npm command shim is launched through the command shell.
- `tests/tmux.test.ts` runs under Bun and uses a Node-based fake tmux executable to test `runTmux` output bounds, timeouts, cancellation, forced termination, and pre-aborted signals. The graceful-SIGTERM assertion skips on native Windows, where child termination semantics differ; no tmux server is required.
- `tests/tmux.node-test.ts` runs the focused `runTmux` subprocess cases under Node's native `node:child_process` implementation, covering pre-aborted signals, output-bound cleanup, cancellation, and graceful timeout exit. Run the Node.js lane alone with `bun run test:node`; it does not need a tmux server.
- `tests/naming.test.ts` covers synthetic credential and explicitly labeled personal-data screening, including Unicode variants, near-misses, and retained-context-boundary cases; it verifies context is screened before model-registry access without echoing matches.
- `tests/title.test.ts` checks that sensitive-looking context is not sent to the model and sensitive-looking output is neither applied nor disclosed; identifier examples are synthetic.
- `tests/unicode-digits.test.ts` verifies runtime-supported decimal digit mappings and conservative handling of unmappable digits.
- `tests/issue-templates.test.ts` parses the issue-form YAML, checks supported field structures and privacy reminders, and keeps blank issues enabled.
- `tests/repository.test.ts` checks README links and limits against the code, and the CI wiring: tested tmux versions, minimum Pi and Node.js versions, secret scanning, `verify` parity with CI, and third-party actions pinned to full commit SHAs with version comments.
- `tests/workflows.test.ts` checks every workflow's permissions and checkout credentials, that the `required` check covers every CI job, and that `src/` uses no Bun APIs.
- `tests/release.test.ts` checks which commit types release, and that git-cliff writes notes Pi can read, with breaking changes and absolute pull request links.

Tmux integration tests use separate temporary servers and skip automatically when `tmux` is unavailable or on native Windows. To run them, install tmux on a Unix-like host: the fixtures use Unix paths (`/dev/null` and `/bin/sleep`), so use Linux, macOS, or WSL. Mock-only tests, including empty window-name parsing and both fake-subprocess suites, do not need tmux. GitHub Actions runs the full tmux suite with Node.js 24 on Ubuntu 24.04 (tmux 3.4) and macOS 15 (Homebrew tmux), and on Ubuntu against a pinned tmux 3.7c source build with Node.js 22.19.0. Windows Server 2025 runs the type checks and mock-capable tests; tmux integration tests are skipped on native Windows. The Node.js lane also runs on 22.19.0 (the declared minimum), 22, 24, and 26, and a separate job runs both lanes against the minimum supported Pi from `engines.pi`. Maintainers can run CI on demand from GitHub Actions or with `gh workflow run CI --ref main`. Tests make no model API calls and do not rename your windows or sessions.

## Deviations from the standard

- The root `index.ts` re-exports the extension together with its title, naming, and tmux helpers, which the tests import. Pi loads `src/extension.ts`.

## Commits and pull requests

Use Conventional Commits and sign off commits with `git commit -s`. Never add a `Co-Authored-By` trailer. PR titles become squash commit subjects and release notes. Keep them user-facing, at most 72 characters, without a final period.

## Automatic releases

Do not edit the development version, create release tags, or publish from your machine. `.github/workflows/cd.yaml` runs CI on pushes to `main`, then semantic-release publishes releasable changes through npm Trusted Publishing with provenance.

- `feat` releases a minor version; `fix`, `perf`, and `revert` release a patch.
- `docs(readme)` releases a patch so npm and the Pi gallery receive README changes.
- Breaking changes release a minor while the package is below 1.0. Remove that override when releasing 1.0.
- CI, toolchain, and maintainer-documentation changes do not release.

The version in `package.json` stays `0.0.0-development`. semantic-release updates only its temporary workspace; it never commits back to `main`. git-cliff generates both the GitHub release notes and the `CHANGELOG.md` shipped in the package. Run `bun run changelog` to preview the history locally.

The release job uses Node.js 24 and the OIDC-capable npm CLI installed with `@semantic-release/npm`. Lifecycle scripts are disabled during publishing.

### One-time publisher setup

The package already exists on npm. Do not bootstrap or republish any existing version.

1. Ensure the workflow is named `cd.yaml`, with a release job in the GitHub environment `npm`.
2. Log into npm interactively and move the trusted publisher from the retired `publish.yml` workflow to `cd.yaml` (npm 12 shown because older global CLIs may not support `trust`):

   ```sh
   npm login
   npx --yes npm@12 trust list @leocavalcante/pi-tmux
   npx --yes npm@12 trust revoke @leocavalcante/pi-tmux --id <publish.yml entry id>
   npx --yes npm@12 trust github @leocavalcante/pi-tmux \
     --file cd.yaml --repo leocavalcante/pi-tmux --env npm --allow-publish
   ```

3. Keep npm publishing access set to require 2FA and disallow tokens. Do not create an `NPM_TOKEN` secret.
4. The GitHub `npm` environment permits deployment from `main` only.
5. After the first automated release, verify the package version, provenance, and update notes:

   ```sh
   npm view @leocavalcante/pi-tmux version dist.attestations
   ```

### Recovering a partial release

Check npm before retrying a failed release. semantic-release pushes the tag before publishing, so a normal re-run may consider that version released already.

- **The version is absent from npm:** investigate the failure. An administrator may delete only the failed release tag and re-run CD on `main` once publishing is fixed.
- **The version exists on npm:** do not delete its tag or try to republish it. npm versions are immutable. Verify provenance, restore any missing GitHub release from that tag, and release a new version for package fixes.
- **Publication succeeded but provenance is missing:** treat this as a release failure. Investigate OIDC and publish a new attested version; existing npm versions cannot be repaired by republishing.

Version 0.1.0 was published once from a maintainer machine, without provenance. Versions 0.1.1 through 0.1.7 were published with provenance by a workflow triggered by GitHub releases, which `cd.yaml` replaces.

## Before submitting

Keep credentials, sessions, model caches, environment files, and personal Pi configuration out of contributions. `.gitignore` is a precaution, not a substitute for reviewing the staged diff and scanning for secrets.

Review the staged files and scan with [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
git diff --cached --check
gitleaks dir . --redact
gitleaks git . --redact
```
