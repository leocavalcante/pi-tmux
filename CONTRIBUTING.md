# Contributing

## Setup

Development uses [Bun](https://bun.sh/docs/installation) 1.4.4 for dependencies, scripts, and most tests, and Node.js 22.19 or newer, which Pi runs extensions on. `bun run test` runs both lanes: Bun's test runner for `tests/*.test.ts`, then Node's native test runner for `tests/*.node-test.ts`.

```sh
git clone https://github.com/leocavalcante/pi-tmux.git
cd pi-tmux
bun install --frozen-lockfile
```

To try the checkout in Pi without changing your settings:

```sh
pi --extension ./index.ts
```

Use either the installed package or the development extension, not both.

## Checks

Run the local validation gates used by CI—TypeScript checks for the extension
and tests, both test lanes, the package check, and the high-severity dependency
audit—with one command:

```sh
bun run verify
```

The individual scripts remain available when you only need a targeted check.
`bun run verify` stops at the first failure. It does not include Gitleaks; install
it separately to run the secret scans under [Before submitting](#before-submitting).

`index.ts` is the package entrypoint and re-exports the public helpers. The implementation lives in focused modules: `src/title.ts` handles title formatting, `src/naming.ts` handles model configuration and context, `src/tmux.ts` owns tmux formats and command adapters, `src/controller.ts` owns per-instance state and updates, and `src/extension.ts` registers commands and lifecycle events. The window snapshot is tab-delimited and its last field can be empty; preserve its trailing tab and remove only tmux's line terminator. Injected `RunTmux` adapters retain flat command arrays by default; adapters that support the server-PID guard can opt in with `supportsServerPidGuard = true`.

## Tests

Run both test lanes:

```sh
bun run test
```

- `bun run check` type-checks `index.ts` and `src/`, then every file under `tests/` with Bun and Node.js types; CI runs this check.
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
- `tests/workflows.test.ts` checks the CI wiring (tested tmux versions, minimum Pi and Node.js versions, secret scanning, and `verify` parity with CI) and keeps third-party GitHub Actions pinned to full commit SHAs with version comments.

Tmux integration tests use separate temporary servers and skip automatically when `tmux` is unavailable or on native Windows. To run them, install tmux on a Unix-like host: the fixtures use Unix paths (`/dev/null` and `/bin/sleep`), so use Linux, macOS, or WSL. Mock-only tests, including empty window-name parsing and both fake-subprocess suites, do not need tmux. GitHub Actions runs the full tmux suite with Node.js 24 on Ubuntu 24.04 (tmux 3.4) and macOS 15 (Homebrew tmux), and on Ubuntu against a pinned tmux 3.7c source build with Node.js 22.19.0. Windows Server 2025 runs the type checks and mock-capable tests; tmux integration tests are skipped on native Windows. The Node.js lane also runs on 22.19.0 (the declared minimum), 22, 24, and 26, and a separate job runs both lanes against the minimum supported Pi from `engines.pi`. Maintainers can run CI on demand from GitHub Actions or with `gh workflow run CI --ref main`. Tests make no model API calls and do not rename your windows or sessions.

## Before submitting

Keep credentials, sessions, model caches, environment files, and personal Pi configuration out of contributions. `.gitignore` is a precaution, not a substitute for reviewing the staged diff and scanning for secrets.

Review the staged files and scan with [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
git diff --cached --check
gitleaks dir . --redact
gitleaks git . --redact
```
